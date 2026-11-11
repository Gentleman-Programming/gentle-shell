import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { after } from "node:test";
import askUserQuestion from "../extensions/ask-user-question.ts";
import gentleAgents from "../extensions/gentle-agents.ts";
import gentleTodo from "../extensions/gentle-todo.ts";
import { requiredPaths } from "../scripts/verify-package-files.mjs";

// cost-speed-painpoints S15 P7: skill and tool-guideline contradictions resolved in the
// direction of the T12 verdicts. Ids (C1, C2, ...) are the verdict file's ids.

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const rdd = read("skills/rdd-defect-workflow/SKILL.md");
const commentWriter = read("skills/comment-writer/SKILL.md");
const workUnits = read("skills/work-unit-commits/SKILL.md");
const harnessSkill = read("skills/gentle-ai/SKILL.md");

type Tool = { name: string; description?: string; promptGuidelines?: string[] };
const tools = new Map<string, Tool>();
const fixture = mkdtempSync(join(tmpdir(), "skill-contradictions-"));
after(() => rmSync(fixture, { recursive: true, force: true }));
const pi = {
	on() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
	registerFlag() {}, getFlag() {}, events: { on() {}, emit() {} },
	registerTool(tool: Tool) { tools.set(tool.name, tool); },
};
gentleAgents(pi as never, { GENTLE_PI_CONFIG_HOME: fixture }, { home: fixture, agentHome: fixture });
gentleTodo(pi as never, {});
askUserQuestion(pi as never);
const guidelines = (name: string) => {
	const tool = tools.get(name);
	assert.ok(tool, `missing registered tool ${name}`);
	return (tool.promptGuidelines ?? []).join("\n");
};
const description = (name: string) => {
	const tool = tools.get(name);
	assert.ok(tool, `missing registered tool ${name}`);
	return tool.description ?? "";
};

test("C1: ~400 changed lines is a planning heuristic that applies the delivery strategy, never a hard stop", () => {
	assert.doesNotMatch(rdd, /The hard limit is|STOP for a chain|Chain or approved exception before edits/);
	assert.match(rdd, /about 400 additions plus deletions \(a planning heuristic, not a hard limit\), apply the feature's delivery strategy and the target repository's size policy/);
	assert.match(rdd, /\| Forecast exceeds about 400 lines \| Apply the delivery strategy and the target size policy; never a hard stop\. \|/);
});

test("C2: an approved issue or `status:approved` is required only where the target repository uses it", () => {
	assert.doesNotMatch(rdd, /Require an approved issue \(`status:approved`\)/);
	assert.match(rdd, /Follow the target repository's issue policy: require an approved issue \(`status:approved`\) only where it uses one/);
	assert.match(rdd, /reproduce on a clean current default branch before implementation/);
	assert.match(rdd, /^1\. Check mode, the repository's issue policy, PR conflicts, and default-branch reproduction\.$/m);
	assert.doesNotMatch(rdd, /current-main reproduction/);
});

test("C4: the todo guideline follows the core rule (large tracked work or on request; small tasks use none)", () => {
	const text = guidelines("todo");
	assert.doesNotMatch(text, /three or more steps/);
	assert.match(text, /Use todo only for large tracked work or when the user asks for one; small tasks need none\./);
	assert.match(text, /Mark a task in_progress before starting/);
});

test("C5: the comment-writer split example follows the target repository's size policy", () => {
	const example = commentWriter.split("### Ask for split")[1]?.split("## Commands")[0] ?? "";
	assert.ok(example, "missing Ask for split example");
	assert.doesNotMatch(example, /size:exception|400-line budget/);
	assert.match(example, /This PR is large for one review/);
	assert.match(example, /follow the repo's size policy/);
});

test("C6: delivery follows changed lines, not a Low/Medium/High risk scale; a high-risk unit gets its own commit", () => {
	const section = workUnits.split("## Delivery And Budget")[1]?.split("## ODD Relationship")[0] ?? "";
	assert.doesNotMatch(section, /Low risk:|Medium risk:|High risk:/);
	assert.match(section, /Up to about 400 forecast or running authored changed lines: keep work-unit commits inside one PR\./);
	assert.match(section, /Above it: follow the selected `delivery_strategy`/);
	assert.match(section, /Risk never picks the delivery strategy; a unit whose Risk line names a high-risk item gets its own commit\./);
});

test("C7: the gentle-ai skill points to the core Writer rule instead of restating it differently", () => {
	const rule = harnessSkill.split("\n").find(line => line.startsWith("- **Writer rule**")) ?? "";
	assert.equal(rule, "- **Writer rule**: outside full delegation, a writer only when two or more independent units of behavior, each heavier than a subagent start, are launched together in one turn, or when the context backstop fires; task size and file count never fire it. In full delegation every write goes to a bounded writer, whatever its size.");
});

test("N1: the gentle-ai skill checks the effective session skills view before the registry file", () => {
	assert.doesNotMatch(harnessSkill, /check the registry\/filesystem for a more specific skill/);
	assert.match(harnessSkill, /check `<available_skills>` and, when present, the `Effective session skills` block for a more specific skill before generic execution \(registry and filesystem only as a fallback\)/);
});

test("S4: work-unit-commits no longer names the removed `review_budget_lines` setting", () => {
	assert.doesNotMatch(workUnits, /review_budget_lines/);
	assert.match(workUnits, /to fit the review budget \(about 400 authored changed lines\)/);
});

test("S10: the work-unit-commits trigger no longer fires on every implementation task", () => {
	const line = workUnits.split("\n").find(entry => entry.startsWith("description:")) ?? "";
	assert.doesNotMatch(line, /implementation/);
	assert.match(line, /Trigger: commit splitting, chained PRs, keeping tests and docs with code\. Plan commits as reviewable work units\./);
});

test("S6: ask_user_question names the decisions it must not take and routes them to ask_user_choice", () => {
	const text = guidelines("ask_user_question");
	assert.doesNotMatch(text, /must not be delegated to the user/);
	assert.match(text, /Consent, maintenance authorizations and exact-token decisions use ask_user_choice, never this tool\./);
});

test("S7: classified-work publication is conditional on classified work, not on every session start", () => {
	const text = description("orchestrator_session_id");
	assert.doesNotMatch(text, /at session start/);
	assert.doesNotMatch(text, /Classified work must publish/);
	assert.match(text, /If you publish classified work, keep objective and work\.topic\/area current on each task-topic change; never retain old task state\./);
	assert.match(text, /Do not require a subject declaration for small direct tasks\./);
});

test("S9: the package file check lists every shipped skill file, including tui-design and references", () => {
	const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
		.flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [relative(root, join(dir, entry.name)).replaceAll("\\", "/")]);
	const listed = new Set<string>(requiredPaths);
	const missing = walk(join(root, "skills")).filter(path => !listed.has(path));
	assert.deepEqual(missing, []);
});
