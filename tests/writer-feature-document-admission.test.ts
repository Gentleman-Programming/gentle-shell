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

