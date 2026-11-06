import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { rejectUnriskedVerifierLaunch } from "../lib/verifier-admission.ts";

// odd/tasks/verifier-admission.md S2: a bench gate run launched `gentle-ai-verify` on a small, not high-risk task
// although the prompt's Verification rule reserves the independent verifier for a named high-risk item. The runtime
// now admits a primary-session verifier launch only with a `Risk: item N` line, a feature-document task, or a
// measured context at the backstop.

const quiet = { tokens: 20_000, contextWindow: 400_000 };

function workspace(withDocument: boolean): string {
	const root = mkdtempSync(join(tmpdir(), "verifier-admission-"));
	if (withDocument) {
		mkdirSync(join(root, "odd", "tasks"), { recursive: true });
		writeFileSync(join(root, "odd", "tasks", "ledger.md"), "# Ledger\n");
	}
	return root;
}

// gentle-shell#2478: the rejection must name the accepted declaration placement, so a caller whose risk sentence
// follows a separator like `; ` (the Andiveli report) learns the conforming form instead of guessing.
test("S5: the rejection names the accepted declaration placement", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	// The reported nonconforming envelope: the declaration follows `; `, which the grammar does not accept.
	const denied = rejectUnriskedVerifierLaunch(
		{ agent: "gentle-ai-verify", task: "Independent verification, read-only repository; Risk: item 2 (authorization tokens). Spec: odd/tasks/example.md, T2, S1-S3." },
		{ root, contextUsage: quiet },
	);
	assert.ok(denied?.block, "the `; `-separated declaration is not recognized");
	assert.match(denied.reason, /A supported `Risk: item N` declaration starts a line/);
	assert.match(denied.reason, /or a sentence \(after `\.`, `!` or `\?` and a space\)/);
	assert.match(denied.reason, /for example `Risk: item 2 \(authorization tokens\)`/);
	assert.match(denied.reason, /after another separator such as `; ` or `,` is not recognized/);
	assert.doesNotMatch(denied.reason, /claude|gpt|openai|anthropic|gemini|sonnet|opus/i, "the message stays generic");
});

test("S3/S4: a verifier launch without a high-risk line is rejected with an inline instruction", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const task of ["Verify the annual budget change.", "Verify it.\nRisk: none", "Verify it.\nRisk: none (local rename)"]) {
		const denied = rejectUnriskedVerifierLaunch({ agent: "gentle-ai-verify", task }, { root, contextUsage: quiet });
		assert.ok(denied?.block, `${JSON.stringify(task)} must be blocked`);
		assert.match(denied.reason, /independent verifier runs only for a change that declares a named high-risk item/);
		assert.match(denied.reason, /focused test and suite inline/);
		assert.match(denied.reason, /do not retry the launch/);
		assert.match(denied.reason, /never add a Risk line or create a feature document only to get a verifier admitted/);
		assert.doesNotMatch(denied.reason, /claude|gpt|openai|anthropic|gemini|sonnet|opus/i, "the message stays generic");
	}
});

test("S3: a Risk line naming a Task Size high-risk item admits the verifier", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const line of ["Risk: item 3 (shared parser)", "- Risk: item 2, item 3 (auth and parser)", "Risk: item 6", "  Risk:item 1"]) {
		assert.equal(rejectUnriskedVerifierLaunch({ agent: "gentle-ai-verify", task: `Verify the change.\n${line}\n` }, { root, contextUsage: quiet }), undefined, line);
	}
	const viaContext = { agent: "gentle-ai-verify", task: "Verify the change.", context: "Risk: item 4 (migration)" };
	assert.equal(rejectUnriskedVerifierLaunch(viaContext, { root, contextUsage: quiet }), undefined, "the context carries the line");
});

// gentle-shell-bench model-economy L9: a DeepSeek verifier launch was refused twice because its valid declaration
// opened a sentence mid-paragraph ("... on top of commit ebf3f35). Risk: item 1 (...)"), not a line.
test("S3: a Risk declaration that opens a sentence admits the verifier", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const task of [
		"Independently verify an ODD change on top of commit ebf3f35. Risk: item 1 (schema migration of stored data).",
		"Verify the parser change! Risk: item 3 (shared parser)",
		"Is the guard still sound? Risk: item 2",
	]) {
		assert.equal(rejectUnriskedVerifierLaunch({ agent: "gentle-ai-verify", task }, { root, contextUsage: quiet }), undefined, task);
	}
	for (const task of ["Verify it. Risk: none (local rename)", "Verify it. Do not write Risk: item 3 here.", "Verify it.Risk: item 3"]) {
		assert.ok(rejectUnriskedVerifierLaunch({ agent: "gentle-ai-verify", task }, { root, contextUsage: quiet })?.block, task);
	}
});

test("S3: an item outside 1-6, a Risk mention inside prose, or none first is rejected", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const line of ["Risk: item 7", "Risk: item 0", "Risk: item 12", "Do not write Risk: item 3 here.", "Risk: none; item 3 does not apply", "Risk: items"]) {
		assert.ok(rejectUnriskedVerifierLaunch({ agent: "gentle-ai-verify", task: `Verify it.\n${line}` }, { root, contextUsage: quiet })?.block, line);
	}
});

test("S3: a task of an existing feature document admits the verifier; a missing document does not", (t) => {
	const documented = workspace(true);
	const bare = workspace(false);
	t.after(() => { rmSync(documented, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); });
	const input = { agent: "gentle-ai-verify", task: 'Spec: odd/tasks/ledger.md (read until "## Log"). Verify T2; S3.' };
	assert.equal(rejectUnriskedVerifierLaunch(input, { root: documented, contextUsage: quiet }), undefined);
	assert.ok(rejectUnriskedVerifierLaunch(input, { root: bare, contextUsage: quiet })?.block, "a missing document does not admit");
});

test("S3: the measured context backstop admits the verifier", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const input = { agent: "gentle-ai-verify", task: "Verify the change." };
	assert.equal(rejectUnriskedVerifierLaunch(input, { root, contextUsage: { tokens: 150_000, contextWindow: 1_000_000 } }), undefined);
	assert.equal(rejectUnriskedVerifierLaunch(input, { root, contextUsage: { tokens: 19_200, contextWindow: 128_000 } }), undefined, "15% of a small window admits");
	assert.ok(rejectUnriskedVerifierLaunch(input, { root, contextUsage: { tokens: 149_999, contextWindow: 1_000_000 } })?.block);
	assert.ok(rejectUnriskedVerifierLaunch(input, { root, contextUsage: undefined })?.block, "missing context usage does not admit");
});

test("S5: other agents are not gated by the verifier admission", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const agent of ["gentle-ai-worker", "worker", "gentle-ai-explore", "jd-fix-agent", "jd-judge-a", "jd-judge-b", "review-risk", "verify"]) {
		assert.equal(rejectUnriskedVerifierLaunch({ agent, task: "Check src/budget.ts" }, { root, contextUsage: quiet }), undefined, agent);
	}
	for (const input of [undefined, null, "gentle-ai-verify", ["gentle-ai-verify"], { task: "Verify it." }]) {
		assert.equal(rejectUnriskedVerifierLaunch(input, { root, contextUsage: quiet }), undefined, JSON.stringify(input));
	}
});

type ToolCallHandler = (event: { toolName: string; input: unknown }, ctx: ExtensionContext) => Promise<{ block?: boolean; reason?: string } | undefined>;

function toolCallThroughHook(toolName: string, input: Record<string, unknown>, cwd: string, tokens: number, processEnv: NodeJS.ProcessEnv = {}) {
	const handlers = new Map<string, ToolCallHandler>();
	const pi = { on(name: string, handler: ToolCallHandler) { handlers.set(name, handler); }, events: { emit() {} }, registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, processEnv })(pi);
	return handlers.get("tool_call")!({ toolName, input }, {
		cwd, hasUI: false, ui: { confirm: async () => true },
		getContextUsage: () => ({ tokens, contextWindow: 272_000, percent: Math.round((tokens / 272_000) * 100) }),
	} as unknown as ExtensionContext);
}

test("S3/S5: the orchestrator tool_call hook gates only primary verifier launches", async (t) => {
	const bare = workspace(false);
	const documented = workspace(true);
	t.after(() => { rmSync(bare, { recursive: true, force: true }); rmSync(documented, { recursive: true, force: true }); });
	const blocked = await toolCallThroughHook("subagent_run", { agent: "gentle-ai-verify", mode: "task", task: "Verify the budget change." }, bare, 20_000);
	assert.equal(blocked?.block, true);
	assert.match(blocked?.reason ?? "", /focused test and suite inline/);
	const risked = await toolCallThroughHook("subagent_run", { agent: "gentle-ai-verify", mode: "task", task: "Verify the budget change.\nRisk: item 3 (shared parser)" }, bare, 20_000);
	assert.equal(risked?.block, undefined, "a named high-risk item admits");
	const documentedLaunch = await toolCallThroughHook("subagent_run", { agent: "gentle-ai-verify", mode: "task", workspace_root: documented, task: "Spec: odd/tasks/ledger.md, T1. Verify it." }, bare, 20_000);
	assert.equal(documentedLaunch?.block, undefined, "the feature document resolves under the selected workspace root");
	const backstop = await toolCallThroughHook("subagent_run", { agent: "gentle-ai-verify", mode: "task", task: "Verify the budget change." }, bare, 136_000);
	assert.equal(backstop?.block, undefined, "half of the measured window admits");
	const child = await toolCallThroughHook("subagent_run", { agent: "gentle-ai-verify", mode: "task", task: "Verify it." }, bare, 0, { GENTLE_PI_AGENTS_CHILD: "1" });
	assert.equal(child?.block, undefined, "a child session is not gated");
	const continuation = await toolCallThroughHook("subagent_continue", { agent: "gentle-ai-verify", task_id: "t-1", task: "Recheck it." }, bare, 0);
	assert.notEqual(continuation?.reason, blocked?.reason, "a continuation is not gated by the verifier admission");
	for (const agent of ["gentle-ai-explore", "jd-judge-a", "jd-judge-b"]) {
		const other = await toolCallThroughHook("subagent_run", { agent, mode: "task", task: "Map src/budget.ts" }, bare, 0);
		assert.equal(other?.block, undefined, `${agent} is unaffected`);
	}
	// A native review relay keeps its own candidate-view gate, which already rejects a dispatch without a frozen view.
	const relay = await toolCallThroughHook("subagent_run", { agent: "review-risk", mode: "task", task: "Review the candidate." }, bare, 0);
	assert.match(relay?.reason ?? "", /^review subagent dispatch /, "review relays keep their previous gate");
	const writer = await toolCallThroughHook("subagent_run", { agent: "gentle-ai-worker", mode: "background", task: "Implement it.\nRisk: item 3\n\n## Allowed edit surfaces\nsrc/budget.ts\n" }, bare, 0);
	assert.match(writer?.reason ?? "", /write this unit inline yourself/, "writer admission is unchanged and ignores Risk lines");
});

test("S6: the Verification rule and the reference docs point at the runtime admission", () => {
	const read = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8");
	assert.ok(read("assets/orchestrator.md").includes("independent `gentle-ai-verify`; else inline; runtime admission, gates/overengineering"), "the core rule names the runtime check");
	assert.ok(read("assets/orchestrator-verification.md").includes("(runtime admits its launch on a `Risk: item N` line or sentence, a feature-document task line, or past the context backstop)"), "the normative rule names the admitted line");
	const docs = read("docs/readme-reference.md");
	const writer = docs.indexOf("A second admission check stops small-task delegation");
	const verifier = docs.indexOf("A third admission check keeps the independent verifier for high-risk changes");
	assert.ok(writer >= 0 && verifier > writer, "the verifier admission is documented right after the writer admission");
	assert.match(docs.slice(verifier, docs.indexOf("\n\n", verifier)), /`gentle-ai-verify` launch is admitted only when[^]*`Risk: item N`[^]*context backstop/);
});

// gentle-shell#2478: the strict placement grammar is unchanged by the diagnostics wording — a declaration after
// `; ` or `,` blocks, a line-start and a sentence-start declaration admit. Covers S2, S5.
test("S2/S5: placement grammar admits line/sentence starts and blocks other separators", (t) => {
	const root = workspace(false);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const verdict = (task: string) => rejectUnriskedVerifierLaunch({ agent: "gentle-ai-verify", task }, { root, contextUsage: quiet })?.block === true;
	assert.equal(verdict("Independent verification, read-only repository; Risk: item 2 (authorization tokens)."), true, "`; ` is not a declaration start");
	assert.equal(verdict("Verification of the parser, Risk: item 2 (reason)."), true, "`,` is not a declaration start");
	assert.equal(verdict("Risk: item 2 (authorization tokens)\nVerify."), false, "line start admits");
	assert.equal(verdict("- Risk: item 2\nVerify."), false, "list marker admits");
	assert.equal(verdict("Deployed on top of ebf3f35. Risk: item 1 (migration)"), false, "sentence start admits");
	assert.equal(verdict("Risk: none\nVerify."), true, "`Risk: none` blocks");
	assert.equal(verdict("Spec: odd/tasks/missing.md"), true, "a missing feature document does not admit");
});

// gentle-shell#2478 S2-S4: the docs section states the strict grammar, the assessment≠admission split, and that the
// post-denial disposition is launch-scoped with no gate-level retry. Covers S2, S3, S4.
test("S2/S3/S4: delegated-verification documents placement, assessment≠admission and post-denial disposition", () => {
	const docs = readFileSync(new URL("../docs/delegated-verification.md", import.meta.url), "utf8");
	const section = docs.split("## Verifier launch admission and post-denial disposition")[1]?.split("\n## ")[0] ?? "";
	assert.match(section, /The declaration grammar is strict: `Risk: item N \(reason\)` must start a line/);
	assert.match(section, /after another separator such as `; ` or `,` inside a sentence is not recognized/);
	assert.match(section, /Keep the risk evidence tied to the actual change; never add a Risk line only to gain admission\./);
	assert.match(section, /Assessment and admission are separate gates/);
	assert.match(section, /does not receive the assessment result/);
	assert.match(section, /no gate-level disposition exists for the same launch: do not retry it/);
	assert.match(section, /The rejection is launch-scoped, not feature-scoped/);
	assert.match(section, /requires the user's explicit decision in a new prompt/);
	assert.match(section, /Inline tests, the writer's self-verification, and a user's visual approval never replace the missing independent verification/);
});
