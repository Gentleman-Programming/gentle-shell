import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codegraphFirstGate from "../extensions/codegraph-first-gate.ts";

/** The exact reason a workspace-search prompt's uncredited persistent-memory read is blocked with. */
const BLOCK_REASON =
	"codegraph-first gate: persistent-memory reads during workspace-search activity come after a codegraph query or explore in the same user prompt (AGENTS.md Memory ordering). Call codegraph first - a failed or unavailable attempt also counts - then retry this memory read; prompts with no workspace search are never gated.";

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
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "t1", args: { operation: "query", query: "symbol" } });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "t1", result: { ok: false, error: "daemon down" } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});

test("(c) a failed codegraph call still credits: the end handler never reads the result payload", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	// Reading any field besides toolName throws, so credit proves the handler ignores the
	// outcome entirely: end-of-execution means the call finalized, failure included.
	const ended: unknown = new Proxy({ toolName: "codegraph", toolCallId: "t1" }, {
		get(target, property, receiver) {
			if (property === "toolName" || property === "toolCallId") return Reflect.get(target, property, receiver);
			throw new Error(`the gate must not read .${String(property)} from tool_execution_end`);
		},
	});
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "t1", args: { operation: "query", query: "symbol" } });
	fire(handlers, "tool_execution_end", ended);
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});

test("(d) an mcp__codegraph__ tool call also credits the prompt", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "mcp__codegraph__codegraph_explore", toolCallId: "t1", args: { query: "flow" } });
	fire(handlers, "tool_execution_end", { toolName: "mcp__codegraph__codegraph_explore", toolCallId: "t1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined);
});

test("(e) a new user prompt resets the credit", (t) => {
	const handlers = installGate(t);
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "t1", args: { operation: "query", query: "symbol" } });
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
	// The credit path is equally guarded: a hostile end event neither throws nor credits.
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
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "a", result: { ok: true } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "B is still active, so A's completion cannot credit the prompt yet");
	fire(handlers, "tool_execution_end", { toolName: "mcp__codegraph__codegraph_query", toolCallId: "b" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "every graph call finalized: credit applies");
	// A new graph call starting after credit was granted invalidates it until it completes.
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "c", args: { operation: "explore", query: "c" } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "a new graph call re-opens the window until it finalizes");
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
	// A failed query still credits: the end handler never reads the result payload.
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "q1", args: { operation: "query", query: "symbol" } });
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "q1", result: { ok: false, error: "daemon down" } });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "a failed query credits like any finalized attempt");
	// An explore through the MCP proxy name credits too - under an armed gate, so the
	// assertion can pass only through the explore's own credit.
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "grep", toolCallId: "m-arm", args: { pattern: "symbol" } });
	fire(handlers, "tool_execution_start", { toolName: "mcp__codegraph__codegraph_explore", toolCallId: "e1", args: { query: "flow" } });
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
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "c1" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "search armed plus credit granted passes");
	// A live graph call blocks memory reads even in a prompt that never searched the workspace.
	fire(handlers, "before_agent_start", { messageType: "user" });
	fire(handlers, "tool_execution_start", { toolName: "codegraph", toolCallId: "c2", args: { operation: "query", query: "symbol" } });
	assert.deepEqual(fire(handlers, "tool_call", { toolName: "mem_search" }), {
		block: true,
		reason: BLOCK_REASON,
	}, "an in-flight codegraph execution always blocks");
	fire(handlers, "tool_execution_end", { toolName: "codegraph", toolCallId: "c2" });
	assert.equal(fire(handlers, "tool_call", { toolName: "mem_search" }), undefined, "finalized credit passes with no search activity");
});
