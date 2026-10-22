import assert from "node:assert/strict";
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
	]) {
		assert.equal(rejectUndocumentedWriterLaunch({ agent: "gentle-ai-worker", task: `${line}\nImplement it.${surfaces}` }, { root, contextUsage: { tokens: 0, contextWindow: 400_000 } }), undefined, line);
	}
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
