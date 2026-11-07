import assert from "node:assert/strict";
import test from "node:test";
import installGentleAgents from "../extensions/gentle-agents.ts";
import installGentleDesign from "../extensions/gentle-design.ts";
import installGentleGuide from "../extensions/gentle-guide.ts";
import installGentleShell from "../extensions/gentle-shell.ts";
import installGentleTodo from "../extensions/gentle-todo.ts";
import installCodeGraphTools from "../extensions/codegraph-tools.ts";
import installAskUserQuestion from "../extensions/ask-user-question.ts";
import installAskUserChoice from "../extensions/ask-user-choice.ts";

// These tool declarations are injected into every primary session's system
// prompt (description + snippet + guidelines + parameter schemas). Only the
// orchestrator trio had a byte budget (tests/orchestrator-prompt-budget.test.ts)
// and the review family gained one in tests/review-tool-prose-budget.test.ts
// (sibling change); every other always-declared declaration grew without a
// cap. This test pins one hard budget over the whole remaining family and the
// authority fragments that must survive any future trim. Operational detail
// belongs in skills/docs/assets; the always-on surface keeps routing and
// invariants.

interface RegisteredDeclaration {
	name: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	parameters?: unknown;
}

const FAMILY_TOOLS = [
	// extensions/gentle-agents.ts (always declared in a primary session)
	"orchestrator_session_id", "orchestrator_consult", "orchestrator_send_message", "orchestrator_list",
	"subagent_run", "subagent_status", "subagent_result", "subagent_list_tasks", "subagent_reply",
	"subagent_cancel", "subagent_send_message", "subagent_continue", "subagent_list_agents",
	"bash_background", "job_list", "job_stop", "monitor",
	// one-tool extensions loaded by default
	"gentle_design", "gentle_design_comments", "gentle_guide", "session_worktree_register",
	"todo", "codegraph", "ask_user_question", "ask_user_choice",
] as const;

const REQUIRED_TOOLS = [
	"orchestrator_session_id", "orchestrator_consult", "orchestrator_send_message", "orchestrator_list",
	"subagent_run", "subagent_status", "subagent_result", "subagent_list_tasks", "subagent_reply",
	"subagent_cancel", "subagent_send_message", "subagent_continue", "subagent_list_agents",
	"todo", "codegraph", "ask_user_question", "ask_user_choice",
] as const;

function registerFamily(): Map<string, RegisteredDeclaration> {
	const tools = new Map<string, RegisteredDeclaration>();
	const pi = {
		on() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
		events: { on() {}, emit() {} },
		registerTool(definition: RegisteredDeclaration) { tools.set(definition.name, definition); },
	};
	const installAll: Array<(pi: unknown) => void> = [
		installGentleAgents as (pi: unknown) => void,
		installGentleDesign as (pi: unknown) => void,
		installGentleGuide as (pi: unknown) => void,
		installGentleShell as (pi: unknown) => void,
		installGentleTodo as (pi: unknown) => void,
		installCodeGraphTools as (pi: unknown) => void,
		installAskUserQuestion as (pi: unknown) => void,
		installAskUserChoice as (pi: unknown) => void,
	];
	for (const install of installAll) install(pi);
	return tools;
}

// Whole-declaration JSON (schemas included) measured 26,345 B before the
// prose trim; descriptions, snippets, guidelines, and parameter descriptions
// were compressed to routing + invariants. The remaining mass is parameter-
// schema contract text and pinned authority/guidance fragments (short-check-
// routing-contract, shell-todo, gentle-design, ask-user-choice), not
// duplicative prose, so the budget pins ~25.5 KB and any regrowth fails.
const FAMILY_PROSE_BUDGET_BYTES = 25_600;

test("agents-family tool declarations fit the always-on prose budget", t => {
	const tools = registerFamily();
	for (const name of REQUIRED_TOOLS) assert.ok(tools.get(name), `missing registered tool ${name}`);
	const measured: Array<[string, number]> = [];
	let total = 0;
	for (const name of FAMILY_TOOLS) {
		const tool = tools.get(name);
		if (!tool) continue;
		const bytes = Buffer.byteLength(JSON.stringify(tool), "utf8");
		measured.push([name, bytes]);
		total += bytes;
	}
	for (const [name, bytes] of measured.sort((a, b) => b[1] - a[1])) t.diagnostic(`${bytes} B  ${name}`);
	t.diagnostic(`TOTAL ${total} B (budget ${FAMILY_PROSE_BUDGET_BYTES} B)`);
	assert.ok(total <= FAMILY_PROSE_BUDGET_BYTES, `agents-family declarations ${total} B exceed the always-on budget ${FAMILY_PROSE_BUDGET_BYTES} B`);
});

test("trimmed agents-family surface keeps the authority fragments", () => {
	const tools = registerFamily();
	const desc = (name: string) => tools.get(name)?.description ?? "";
	const guidelines = (name: string) => (tools.get(name)?.promptGuidelines ?? []).join("\n");

	// orchestrator_session_id publication contract (orchestrator-status-publication-contract.test.ts)
	assert.match(desc("orchestrator_session_id"), /Names never authenticate/);
	assert.match(desc("orchestrator_session_id"), /Progress is published automatically from the todo list/);
	assert.doesNotMatch(desc("orchestrator_session_id"), /Before meaningful work, publish subject/);
	// ask_user_choice authority rules (tests/ask-user-choice.test.ts)
	assert.match(desc("ask_user_choice"), /allowCustomResponse/);
	assert.match(guidelines("ask_user_choice"), /Never enable allowCustomResponse.*provider-owned consent prompts.*maintenance authorizations.*exact opaque token/s);
	// todo discipline (tests/shell-todo.test.ts)
	assert.match(guidelines("todo"), /Mark a task in_progress before starting/);
	// gentle_design handoff vocabulary (tests/gentle-design.test.ts)
	assert.match(desc("gentle_design"), /handoff/);
	assert.match(desc("gentle_design"), /in_progress/);
	assert.match(desc("gentle_design"), /implemented/);
	assert.match(desc("gentle_design"), /previewUrl/);
	// delegation capability contract (tests/task-size-routing-contract.test.ts):
	// the "declared `tools`" fragment lives in assets/orchestrator-delegation.md
	// (guarded there), not in tool prose; keep the routing descriptions lean.
	assert.match(desc("subagent_list_agents"), /subagents defined for this project/);
});
