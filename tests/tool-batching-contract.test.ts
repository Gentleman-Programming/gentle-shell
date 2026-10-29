import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Pain-point iteration S13 (C9/C10, from the S12 session analysis): subagents
// spent 78% of their turns on a single tool call, and 31% of their turns were
// consecutive read-only calls one turn could batch; the parent read repo files
// and then delegated, and 69% of the files it read were read again by the
// worker. Codex reads 8 files with one command. These are instruction-delivery
// contracts, not proof of model adherence.

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

function containsAll(text: string, clauses: readonly string[], label: string): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `${label} is missing: ${clause}`);
}

function declaredTools(prompt: string): string[] {
	const frontmatter = prompt.split("\n---\n")[0];
	return [...frontmatter.matchAll(/^\s+- (\S+)$/gm)].map((match) => match[1]);
}

test("S13 C9: every generic subagent prompt batches independent tool calls in one turn", () => {
	for (const agent of ["gentle-ai-worker", "gentle-ai-verify", "gentle-ai-explore"]) {
		const prompt = read(`assets/agents/${agent}.md`);
		const rule = prompt.split("\n").find((line) => line.includes("**Batch tool calls:**"));
		assert.ok(rule, `${agent} must carry the batch tool calls rule`);
		containsAll(rule, [
			"issue independent calls together in the same turn (parallel tool calls)",
			"read each relevant file whole once instead of many small ranges",
		], agent);
		const tools = declaredTools(prompt);
		// A shell-less agent must not be told to read files or run tests with a command it cannot run.
		if (tools.includes("bash")) {
			containsAll(rule, ["read several files with one command", "the focused test and the suite without status-only turns"], agent);
		} else {
			assert.doesNotMatch(rule, /one command|the suite/, `${agent} has no shell, so its rule must not name a command`);
		}
		if (tools.includes("edit")) containsAll(rule, ["all edits to one file in one `edit` call"], agent);
	}
});

test("S13 C10: the delegation card keeps the parent from reading what the worker will read", () => {
	const card = read("assets/orchestrator-delegation.md");
	const rule = card.split("\n").find((line) => line.startsWith("**Preparation trigger:**"));
	assert.ok(rule, "the delegation card must carry the Preparation trigger");
	containsAll(rule, [
		"When delegating, read only what decides the route",
		"never the files the worker will read",
		"pass paths, the spec reference, and what to change, not file contents",
	], "delegation card preparation trigger");
});

// S13 C9 parent: 95 of 389 parent turns did only coordination (todo 55, orchestrator_session_id 17,
// gentle_review assess 14, subagent_list_agents 8) and parent multi-tool turns were ~0.
test("S13 C9: the always-on orchestrator batches independent calls and never spends a turn only on coordination", () => {
	const core = read("assets/orchestrator.md");
	containsAll(core, [
		"Batch independent tool calls in one turn (parallel calls or one multi-file command).",
		"Never spend a turn only on a `todo` or status update.",
	], "orchestrator core");
});
