import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { rejectUndocumentedWriterLaunch } from "../lib/bounded-writer-admission.ts";
import { CONTEXT_BACKSTOP_TOKENS_ENV } from "../lib/context-backstop.ts";

// Pain-point iteration S16. Prompt rules alone did not stop small-task delegation: on a two-feature request the
// orchestrator still started two writers for ~35-line units (USD 0.36 vs 0.20 inline). A generic writer launch is
// now admitted only for a task of an existing ODD feature document, or when the parent's measured context reaches
// the context backstop.

const surfaces = "\n\n## Allowed edit surfaces\nsrc/budget.ts\n";

function workspace(withDocument: boolean): string {
	const root = mkdtempSync(join(tmpdir(), "writer-admission-"));
	if (withDocument) {
		mkdirSync(join(root, "odd", "tasks"), { recursive: true });
		writeFileSync(join(root, "odd", "tasks", "ledger.md"), "# Ledger\n");
	}
	return root;
}

test("S16: a writer launch without a feature-document task is rejected with an inline instruction", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const denied = rejectUndocumentedWriterLaunch({ agent: "gentle-ai-worker", task: `Implement annual budgets.${surfaces}` }, { root, contextUsage: { tokens: 20_000, contextWindow: 400_000 } });
	assert.ok(denied?.block, "the launch must be blocked");
	assert.match(denied.reason, /write this unit inline yourself/);
	assert.match(denied.reason, /do not retry/);
	assert.match(denied.reason, /never create a feature document only to launch writers/);
});

test("S16: a writer naming a task of an existing feature document is admitted", (t) => {
	const root = workspace(true);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const input = { agent: "gentle-ai-worker", task: `Spec: odd/tasks/ledger.md, T2, S3-S4. Read until ## Log.${surfaces}` };
	assert.equal(rejectUndocumentedWriterLaunch(input, { root, contextUsage: { tokens: 20_000, contextWindow: 400_000 } }), undefined);
	const viaContext = { agent: "worker", task: `Implement it.${surfaces}`, context: "Spec: odd/tasks/ledger.md, T1" };
	assert.equal(rejectUndocumentedWriterLaunch(viaContext, { root, contextUsage: { tokens: 20_000, contextWindow: 400_000 } }), undefined);
});

test("S16: a Spec reference to a missing document, or one escaping the root, is rejected", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const spec of ["odd/tasks/ledger.md", "odd/tasks/../../etc/passwd.md"]) {
		const denied = rejectUndocumentedWriterLaunch({ agent: "gentle-ai-worker", task: `Spec: ${spec}, T1${surfaces}` }, { root, contextUsage: { tokens: 20_000, contextWindow: 400_000 } });
		assert.ok(denied?.block, `${spec} must not admit a writer`);
	}
});

test("S16: the measured context backstop admits a writer without a document", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const input = { agent: "gentle-ai-worker", task: `Implement annual budgets.${surfaces}` };
	assert.equal(rejectUndocumentedWriterLaunch(input, { root, contextUsage: { tokens: 150_000, contextWindow: 1_000_000 } }), undefined);
	assert.ok(rejectUndocumentedWriterLaunch(input, { root, contextUsage: { tokens: 149_999, contextWindow: 1_000_000 } })?.block, "below the backstop does not admit");
	assert.ok(rejectUndocumentedWriterLaunch(input, { root, contextUsage: { tokens: null, contextWindow: 400_000 } })?.block, "unknown context usage does not admit");
	assert.ok(rejectUndocumentedWriterLaunch(input, { root, contextUsage: undefined })?.block, "missing context usage does not admit");
});

// Harness roadmap R1: the admission uses the same threshold as the runtime notice, min(absolute cap, fraction x
// window), so a small context window reaches the backstop at 15% of its size instead of a fixed 150,000 tokens.
test("S16: the admission backstop scales with the measured context window and honors the environment", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const input = { agent: "gentle-ai-worker", task: `Implement annual budgets.${surfaces}` };
	const decide = (tokens: number, contextWindow: number, env?: NodeJS.ProcessEnv) => rejectUndocumentedWriterLaunch(input, { root, contextUsage: { tokens, contextWindow }, env })?.block ?? false;
	assert.equal(decide(19_200, 128_000), false, "15% of a small window admits");
	assert.equal(decide(19_199, 128_000), true);
	assert.equal(decide(150_000, 1_000_000), false, "a large window keeps the absolute cap");
	assert.equal(decide(149_999, 1_000_000), true);
	assert.equal(decide(120_000, 1_000_000), true);
	assert.equal(decide(120_000, 1_000_000, { [CONTEXT_BACKSTOP_TOKENS_ENV]: "100000" }), false, "the cap is overridable");
});

test("S16: previous behavior holds for non-writers and Judgment Day fix agents", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const agent of ["gentle-ai-explore", "gentle-ai-verify", "jd-fix-agent"]) {
		assert.equal(rejectUndocumentedWriterLaunch({ agent, task: "Read src/budget.ts" }, { root, contextUsage: { tokens: 0, contextWindow: 400_000 } }), undefined, agent);
	}
});

type ToolCallHandler = (event: { toolName: string; input: unknown }, ctx: ExtensionContext) => Promise<{ block?: boolean; reason?: string } | undefined>;

function launchThroughHook(input: Record<string, unknown>, cwd: string, tokens: number, processEnv: NodeJS.ProcessEnv = {}, contextWindow = 272_000) {
	const handlers = new Map<string, ToolCallHandler>();
	const pi = { on(name: string, handler: ToolCallHandler) { handlers.set(name, handler); }, events: { emit() {} }, registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, processEnv })(pi);
	return handlers.get("tool_call")!({ toolName: "subagent_run", input }, {
		cwd, hasUI: false, ui: { confirm: async () => true },
		getContextUsage: () => ({ tokens, contextWindow, percent: Math.round((tokens / contextWindow) * 100) }),
	} as unknown as ExtensionContext);
}

test("S16: the orchestrator tool_call hook blocks an undocumented writer and admits a documented one", async (t) => {
	const bare = workspace(false);
	const documented = workspace(true);
	t.after(() => { rmSync(bare, { recursive: true, force: true }); rmSync(documented, { recursive: true, force: true }); });
	const blocked = await launchThroughHook({ agent: "gentle-ai-worker", mode: "background", task: `Implement annual budgets.${surfaces}` }, bare, 20_000);
	assert.equal(blocked?.block, true);
	assert.match(blocked?.reason ?? "", /write this unit inline yourself/);
	const admitted = await launchThroughHook({ agent: "gentle-ai-worker", mode: "background", task: `Spec: odd/tasks/ledger.md, T1. Read until ## Log.${surfaces}` }, documented, 20_000);
	assert.equal(admitted?.block, undefined);
	const explorer = await launchThroughHook({ agent: "gentle-ai-explore", mode: "task", task: "Map src/budget.ts" }, bare, 20_000);
	assert.equal(explorer?.block, undefined, "read-only subagents are unaffected");
	// The hook passes the measured window, not only the tokens: 19.2k of a 128k window is at the backstop.
	const smallWindow = await launchThroughHook({ agent: "gentle-ai-worker", mode: "background", task: `Implement annual budgets.${surfaces}` }, bare, 19_200, {}, 128_000);
	assert.equal(smallWindow?.block, undefined, "15% of the measured window admits");
	const envCap = await launchThroughHook({ agent: "gentle-ai-worker", mode: "background", task: `Implement annual budgets.${surfaces}` }, bare, 19_200, { GENTLE_PI_CONTEXT_BACKSTOP_FRACTION: "0.9" }, 128_000);
	assert.equal(envCap?.block, true, "the hook reads the session environment");
});

// Verifier B1: the delegation card tells the parent to write `Spec: odd/tasks/<feature>.md (read until "## Log").
// Do T#; S#.`, and a live x6 run wrote `Spec: ... .md T1 S1;`. Both name a document task and must be admitted.
test("S16: the delegation card format and a comma-free task reference are admitted", (t) => {
	const root = workspace(true);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const line of [
		'Spec: odd/tasks/ledger.md (read until "## Log"). Do T2; S3.',
		"Spec: odd/tasks/ledger.md T1 S1; read through Tasks before Log.",
		"- Spec: `odd/tasks/ledger.md`, T4",
		"Spec: odd/tasks/ledger.md, T2–T4, S1",
		"Spec: odd/tasks/ledger.md, T2..T4, S1",
	]) {
		assert.equal(rejectUndocumentedWriterLaunch({ agent: "gentle-ai-worker", task: `${line}\nImplement it.${surfaces}` }, { root, contextUsage: { tokens: 0, contextWindow: 400_000 } }), undefined, line);
	}
});

test("canonical Spec launches from a repository subdirectory use its Git root for writers and verifiers", async t => {
	const root = workspace(true);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "--quiet", root]);
	const cwd = join(root, "frontend");
	mkdirSync(cwd);
	for (const agent of ["gentle-ai-worker", "gentle-ai-verify"]) {
		const result = await launchThroughHook({ agent, task: `Spec: odd/tasks/ledger.md, T2–T4, S1${surfaces}` }, cwd, 0);
		assert.equal(result?.block, undefined, `${agent}: ${result?.reason}`);
	}
});

test("an explicit repository target never borrows the session repository's document", async t => {
	const root = workspace(true);
	const other = workspace(false);
	t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });
	execFileSync("git", ["init", "--quiet", root]);
	execFileSync("git", ["init", "--quiet", other]);
	const result = await launchThroughHook({ agent: "gentle-ai-worker", repository_root: other, task: `Spec: odd/tasks/ledger.md, T1${surfaces}` }, root, 0);
	assert.equal(result?.block, true);
});

test("S16: a Spec mention inside prose, outside odd/tasks, or through a symlink leaving the root is rejected", (t) => {
	const root = workspace(true);
	const outside = mkdtempSync(join(tmpdir(), "writer-admission-outside-"));
	t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
	writeFileSync(join(root, "README.md"), "# readme\n");
	writeFileSync(join(outside, "elsewhere.md"), "# elsewhere\n");
	symlinkSync(join(outside, "elsewhere.md"), join(root, "odd", "tasks", "link-out.md"));
	for (const task of [
		"Do not use Spec: odd/tasks/ledger.md, T1 here.",
		"Spec: odd/tasks/../../README.md, T1",
		"Spec: odd/tasks/link-out.md, T1",
	]) {
		assert.ok(rejectUndocumentedWriterLaunch({ agent: "gentle-ai-worker", task: `${task}${surfaces}` }, { root, contextUsage: { tokens: 0, contextWindow: 400_000 } })?.block, task);
	}
});

test("S16: child sessions are exempt and an empty workspace_root falls back to the session cwd", async (t) => {
	const bare = workspace(false);
	const documented = workspace(true);
	t.after(() => { rmSync(bare, { recursive: true, force: true }); rmSync(documented, { recursive: true, force: true }); });
	const child = await launchThroughHook({ agent: "gentle-ai-worker", mode: "background", task: `Implement it.${surfaces}` }, bare, 0, { GENTLE_PI_AGENTS_CHILD: "1" });
	assert.equal(child?.block, undefined, "a child session is not gated");
	const emptyRoot = await launchThroughHook({ agent: "gentle-ai-worker", mode: "background", workspace_root: "", task: `Spec: odd/tasks/ledger.md, T1${surfaces}` }, documented, 0);
	assert.equal(emptyRoot?.block, undefined, "an empty workspace_root means the session cwd");
});

// full-delegation-mode-conflicts S1/S7. In full delegation mode the orchestrator never implements, so the admission
// above would deadlock every small task: the prompt forbids the inline write and this guard forbids the writer.
// The mode admits the generic writer; the edit-surface guard, which runs first, still applies.

test("S1: full delegation mode admits a writer with no feature document, below the backstop", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const input = { agent: "gentle-ai-worker", task: `Change the accent colors.${surfaces}` };
	const contextUsage = { tokens: 20_000, contextWindow: 400_000 };
	assert.equal(rejectUndocumentedWriterLaunch(input, { root, contextUsage, orchestratorMode: "full-delegation" }), undefined);
	// Organic mode, stated explicitly, keeps today's rejection word for word.
	const organic = rejectUndocumentedWriterLaunch(input, { root, contextUsage, orchestratorMode: "organic" });
	assert.equal(organic?.block, true);
	assert.match(organic?.reason ?? "", /write this unit inline yourself/);
});

test("S1: full delegation mode admits only generic writers, never widens other agents", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const contextUsage = { tokens: 20_000, contextWindow: 400_000 };
	for (const agent of ["gentle-ai-explore", "jd-fix-agent"]) {
		assert.equal(rejectUndocumentedWriterLaunch({ agent, task: "x" }, { root, contextUsage, orchestratorMode: "full-delegation" }), undefined, agent);
	}
});

function withConfigHome<T>(workflowMode: string | undefined, run: (home: string) => Promise<T>): Promise<T> {
	const home = mkdtempSync(join(tmpdir(), "writer-admission-home-"));
	writeFileSync(join(home, "profiles.json"), JSON.stringify({
		kind: "gentle-pi.agent_model_profiles",
		version: 1,
		active: "frontier-local",
		profiles: { "frontier-local": { orchestrator: { model: "openai/gpt-6.1-terra" } } },
		...(workflowMode === undefined ? {} : { workflow: { "frontier-local": { orchestratorMode: workflowMode } } }),
	}));
	const previous = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = home;
	return run(home).finally(() => {
		if (previous === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previous;
		rmSync(home, { recursive: true, force: true });
	});
}

test("S7: the reported deadlock — a full delegation profile delegates a small task through the real hook", async (t) => {
	const bare = workspace(false);
	t.after(() => rmSync(bare, { recursive: true, force: true }));
	await withConfigHome("full-delegation", async () => {
		const admitted = await launchThroughHook({ agent: "gentle-ai-worker", mode: "background", task: `Change the accent colors.${surfaces}` }, bare, 20_000);
		assert.equal(admitted?.block, undefined, "the small task reaches the writer instead of being sent back inline");
		// The mode never lifts the edit-surface requirement: that guard runs before admission.
		const unscoped = await launchThroughHook({ agent: "gentle-ai-worker", mode: "background", task: "Change the accent colors." }, bare, 20_000);
		assert.equal(unscoped?.block, true, "a writer without allowed edit surfaces is still refused");
		assert.doesNotMatch(unscoped?.reason ?? "", /write this unit inline yourself/);
	});
});

test("S1: an organic profile keeps the undocumented-writer rejection through the real hook", async (t) => {
	const bare = workspace(false);
	t.after(() => rmSync(bare, { recursive: true, force: true }));
	await withConfigHome(undefined, async () => {
		const blocked = await launchThroughHook({ agent: "gentle-ai-worker", mode: "background", task: `Change the accent colors.${surfaces}` }, bare, 20_000);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /write this unit inline yourself/);
	});
});

test("S1: the session environment override reaches the guard, as it reaches the prompt", async (t) => {
	const bare = workspace(false);
	t.after(() => rmSync(bare, { recursive: true, force: true }));
	await withConfigHome(undefined, async () => {
		const admitted = await launchThroughHook({ agent: "gentle-ai-worker", mode: "background", task: `Change the accent colors.${surfaces}` }, bare, 20_000, { GENTLE_PI_ORCHESTRATOR_MODE: "full-delegation" });
		assert.equal(admitted?.block, undefined);
	});
});

// Independent verification probe (B-S1): an omitted and an organic mode decide exactly alike for every agent and
// context, and full delegation widens only the two generic writers.
test("S1: an omitted or organic mode decides exactly alike; full delegation widens only generic writers", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const agent of ["gentle-ai-worker", "worker", "gentle-ai-explore", "gentle-ai-verify", "jd-fix-agent", "unknown"]) {
		for (const contextUsage of [undefined, { tokens: 20_000, contextWindow: 400_000 }, { tokens: 150_000, contextWindow: 1_000_000 }]) {
			const input = { agent, task: `Do it.${surfaces}` };
			const omitted = rejectUndocumentedWriterLaunch(input, { root, contextUsage });
			assert.deepEqual(rejectUndocumentedWriterLaunch(input, { root, contextUsage, orchestratorMode: "organic" }), omitted, agent);
			const full = rejectUndocumentedWriterLaunch(input, { root, contextUsage, orchestratorMode: "full-delegation" });
			assert.deepEqual(full, agent === "gentle-ai-worker" || agent === "worker" ? undefined : omitted, agent);
		}
	}
});


// cost-speed P6 (R1, option A of L50): the parallel reason is "two or more independent units launched together in
// one turn", in background mode or not. Pi persists the assistant message on `message_end`, before it prepares any
// of its tool calls, so the `tool_call` hook reads the whole batch from the session branch. Organic admits a generic
// writer below the backstop, without a feature document, only when every tool call of that message is a generic
// writer launch, there are at least two, and their `## Allowed edit surfaces` are pairwise disjoint.

type BatchCall = { id: string; name: string; arguments: Record<string, unknown> };
type BatchHandler = (event: { toolName: string; toolCallId: string; input: unknown; parentToolCallId?: string }, ctx: ExtensionContext) => Promise<{ block?: boolean; reason?: string } | undefined>;

const writerCall = (id: string, surface: string, extra: Record<string, unknown> = {}): BatchCall => ({
	id, name: "subagent_run", arguments: { agent: "gentle-ai-worker", task: `Implement ${id}.\n\n## Allowed edit surfaces\n${surface}\n`, ...extra },
});

/** One session branch of assistant messages (each a batch of tool calls), every call answered before the next message. */
function sessionOf(messages: BatchCall[][]) {
	const entries: Array<{ type: string; id: string; parentId: string | null; message: Record<string, unknown> }> = [];
	for (const [index, calls] of messages.entries()) {
		entries.push({ type: "message", id: `a${index}`, parentId: entries.at(-1)?.id ?? null, message: { role: "assistant", content: calls.map(call => ({ type: "toolCall", ...call })) } });
		if (index < messages.length - 1) for (const call of calls) entries.push({ type: "message", id: `r${call.id}`, parentId: entries.at(-1)!.id, message: { role: "toolResult", toolCallId: call.id, content: [] } });
	}
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	return { getLeafEntry: () => entries.at(-1), getEntry: (id: string) => byId.get(id) };
}

async function launchBatchThroughHook(messages: BatchCall[][], target: BatchCall, cwd: string, tokens = 20_000, processEnv: NodeJS.ProcessEnv = {}, parentToolCallId?: string) {
	const handlers = new Map<string, BatchHandler>();
	const pi = { on(name: string, handler: BatchHandler) { handlers.set(name, handler); }, events: { emit() {} }, registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, processEnv })(pi);
	return handlers.get("tool_call")!({ toolName: target.name, toolCallId: target.id, input: target.arguments, ...(parentToolCallId ? { parentToolCallId } : {}) }, {
		cwd, hasUI: false, ui: { confirm: async () => true },
		sessionManager: sessionOf(messages),
		getContextUsage: () => ({ tokens, contextWindow: 272_000, percent: Math.round((tokens / 272_000) * 100) }),
	} as unknown as ExtensionContext);
}

const loneRejection = async (cwd: string) => (await launchThroughHook(writerCall("solo", "src/solo.ts").arguments, cwd, 20_000))?.reason;

test("P6: two generic writers with disjoint surfaces in one assistant message are both admitted in organic mode", async (t) => {
	const bare = workspace(false);
	t.after(() => rmSync(bare, { recursive: true, force: true }));
	await withConfigHome(undefined, async () => {
		const pair = [writerCall("w1", "src/budget.ts"), writerCall("w2", "src/ledger/**")];
		for (const target of pair) {
			const result = await launchBatchThroughHook([pair], target, bare);
			assert.equal(result?.block, undefined, `${target.id}: ${result?.reason}`);
		}
		// Background mode or not is how they run, never a condition (L41).
		const background = [writerCall("b1", "src/a.ts", { mode: "background" }), writerCall("b2", "src/b.ts", { mode: "background" }), writerCall("b3", "docs/c.md")];
		for (const target of background) assert.equal((await launchBatchThroughHook([background], target, bare))?.block, undefined, target.id);
	});
});

test("P6: a lone writer, overlapping or uninterpretable surfaces, and a writer beside another tool keep today's rejection", async (t) => {
	const bare = workspace(false);
	t.after(() => rmSync(bare, { recursive: true, force: true }));
	await withConfigHome(undefined, async () => {
		const expected = await loneRejection(bare);
		assert.ok(expected?.includes("write this unit inline yourself now; do not retry the launch, and never create a feature document only to launch writers"));
		const cases: Record<string, BatchCall[]> = {
			lone: [writerCall("l1", "src/budget.ts")],
			overlapping: [writerCall("o1", "src/**"), writerCall("o2", "src/budget.ts")],
			"same file": [writerCall("s1", "src/budget.ts"), writerCall("s2", "SRC/budget.ts")],
			uninterpretable: [writerCall("u1", "src/[ab].ts"), writerCall("u2", "lib/c.ts")],
			"writer plus explorer": [writerCall("e1", "src/a.ts"), { id: "e2", name: "subagent_run", arguments: { agent: "gentle-ai-explore", task: "Map src/b.ts" } }],
			"writer plus verifier": [writerCall("v1", "src/a.ts"), { id: "v2", name: "subagent_run", arguments: { agent: "gentle-ai-verify", task: "Verify.\nRisk: item 3 (shared parser)" } }],
			"writer plus Judgment Day fix agent": [writerCall("j1", "src/a.ts"), { id: "j2", name: "subagent_run", arguments: { agent: "jd-fix-agent", task: "Fix.\n\n## Allowed edit surfaces\nsrc/b.ts\n" } }],
			// A sequential tool serializes the whole message (L36); any other tool beside the launches is refused too.
			"writers plus todo": [writerCall("t1", "src/a.ts"), writerCall("t2", "src/b.ts"), { id: "t3", name: "todo", arguments: { action: "list" } }],
			"writers plus read": [writerCall("r1", "src/a.ts"), writerCall("r2", "src/b.ts"), { id: "r3", name: "read", arguments: { path: "README.md" } }],
		};
		for (const [label, batch] of Object.entries(cases)) {
			const result = await launchBatchThroughHook([batch], batch[0], bare);
			assert.equal(result?.block, true, label);
			assert.equal(result?.reason, expected, `${label}: the rejection stays byte-identical`);
		}
	});
});

test("P6: writers split across two assistant messages, or launched through codemode, are each rejected", async (t) => {
	const bare = workspace(false);
	t.after(() => rmSync(bare, { recursive: true, force: true }));
	await withConfigHome(undefined, async () => {
		const expected = await loneRejection(bare);
		const first = writerCall("m1", "src/a.ts");
		const second = writerCall("m2", "src/b.ts");
		assert.equal((await launchBatchThroughHook([[first]], first, bare))?.reason, expected, "first message");
		assert.equal((await launchBatchThroughHook([[first], [second]], second, bare))?.reason, expected, "second message");
		// A codemode script's calls are nested: the message holds one `codemode` call, never the launches themselves.
		const script = { id: "cm", name: "codemode", arguments: { code: "await Promise.all([subagent_run(a), subagent_run(b)])" } };
		const nested = writerCall("n1", "src/a.ts");
		assert.equal((await launchBatchThroughHook([[script]], nested, bare, 20_000, {}, "cm"))?.reason, expected, "codemode launch");
	});
});

test("P6 preserve: full delegation, a feature-document task and the backstop still admit a lone writer", async (t) => {
	const bare = workspace(false);
	const documented = workspace(true);
	t.after(() => { rmSync(bare, { recursive: true, force: true }); rmSync(documented, { recursive: true, force: true }); });
	await withConfigHome(undefined, async () => {
		const lone = writerCall("p1", "src/a.ts");
		assert.equal((await launchBatchThroughHook([[lone]], lone, bare, 20_000, { GENTLE_PI_ORCHESTRATOR_MODE: "full-delegation" }))?.block, undefined, "full delegation");
		const spec = writerCall("p2", "src/a.ts", { task: "Spec: odd/tasks/ledger.md, T1\n\n## Allowed edit surfaces\nsrc/a.ts\n" });
		assert.equal((await launchBatchThroughHook([[spec]], spec, documented))?.block, undefined, "feature-document task");
		assert.equal((await launchBatchThroughHook([[lone]], lone, bare, 150_000))?.block, undefined, "context backstop");
		// The edit-surface guard still runs first, inside a batch too.
		const unscoped = { id: "p3", name: "subagent_run", arguments: { agent: "gentle-ai-worker", task: "No surfaces." } };
		const batch = [writerCall("p4", "src/a.ts"), unscoped];
		const denied = await launchBatchThroughHook([batch], unscoped, bare);
		assert.equal(denied?.block, true);
		assert.doesNotMatch(denied?.reason ?? "", /write this unit inline yourself/);
		// ...and its sibling, whose batch partner has no valid surfaces, is not admitted by the batch rule.
		assert.equal((await launchBatchThroughHook([batch], batch[0], bare))?.block, true, "a sibling without surfaces voids the batch");
	});
});

// cost-speed P6b: full delegation launched its independent writers from one `codemode` script before PR #3110 and the
// children overlapped; the prompt now names both routes, so the hook must keep admitting both (preservation).
test("P6b preserve: full delegation admits three writers launched from one codemode script and three in one message", async (t) => {
	const bare = workspace(false);
	t.after(() => rmSync(bare, { recursive: true, force: true }));
	await withConfigHome(undefined, async () => {
		const full = { GENTLE_PI_ORCHESTRATOR_MODE: "full-delegation" };
		const script = { id: "cm", name: "codemode", arguments: { code: "await Promise.allSettled([tools.subagent_run(a), tools.subagent_run(b), tools.subagent_run(c)])" } };
		const nested = [writerCall("cm/1", "src/alpha.ts"), writerCall("cm/2", "src/beta.ts"), writerCall("cm/3", "src/gamma.ts")];
		for (const target of nested) {
			const result = await launchBatchThroughHook([[script]], target, bare, 20_000, full, "cm");
			assert.equal(result?.block, undefined, `codemode ${target.id}: ${result?.reason}`);
		}
		const trio = [writerCall("t1", "src/alpha.ts"), writerCall("t2", "src/beta.ts"), writerCall("t3", "src/gamma.ts")];
		for (const target of trio) {
			const result = await launchBatchThroughHook([trio], target, bare, 20_000, full);
			assert.equal(result?.block, undefined, `same message ${target.id}: ${result?.reason}`);
		}
	});
});

test("P6: the rejection names the same-message route and keeps the inline instruction", () => {
	const root = workspace(false);
	try {
		const denied = rejectUndocumentedWriterLaunch({ agent: "gentle-ai-worker", task: `Implement it.${surfaces}` }, { root, contextUsage: { tokens: 0, contextWindow: 400_000 } });
		assert.match(denied?.reason ?? "", /two or more writers with disjoint `## Allowed edit surfaces` launched together in one message with no other tool call/);
		assert.ok(denied?.reason.endsWith("write this unit inline yourself now; do not retry the launch, and never create a feature document only to launch writers."));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

// Verifier mwb9qlc5-22-nfsa probes, kept as regression tests.
test("P6: a writer beside gentle-ai-explore, and a path beside an uninterpretable glob, are rejected with the new text", async (t) => {
	const bare = workspace(false);
	t.after(() => rmSync(bare, { recursive: true, force: true }));
	await withConfigHome(undefined, async () => {
		const withExplorer = [writerCall("x1", "src/alpha.ts"), { id: "x2", name: "subagent_run", arguments: { agent: "gentle-ai-explore", task: "Map src/beta.ts" } }];
		const denied = await launchBatchThroughHook([withExplorer], withExplorer[0], bare);
		assert.equal(denied?.block, true);
		assert.match(denied?.reason ?? "", /two or more writers with disjoint `## Allowed edit surfaces` launched together in one message with no other tool call/);
		const glob = [writerCall("g1", "src/alpha.ts"), writerCall("g2", "src/[ab].ts")];
		for (const target of glob) assert.equal((await launchBatchThroughHook([glob], target, bare))?.block, true, target.id);
	});
});
