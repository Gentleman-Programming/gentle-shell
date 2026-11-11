import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Cost/speed pain points S4 (T3; L3): children re-read SKILL.md files (~273k
// tokens; `work-unit-commits` 137 times, `cognitive-doc-design` 134 times by
// children that neither committed nor wrote docs) and ODD specs (~282k tokens),
// child reports pasted into the parent were the second-largest source of parent
// context growth, and part of the correction rounds came from the verifier's own
// setup mistakes. These pin prompt guidance, not model compliance.

const read = (relative: string): string => readFileSync(join(import.meta.dirname, "..", relative), "utf8");
const skills = read("assets/orchestrator-skills.md");
const agents = {
	worker: read("assets/agents/gentle-ai-worker.md"),
	verify: read("assets/agents/gentle-ai-verify.md"),
	explore: read("assets/agents/gentle-ai-explore.md"),
};

function containsAll(text: string, clauses: readonly string[], label: string): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `${label} is missing: ${clause}`);
}

test("S4 skills: the parent passes only skills matching the delegated task's files and actions, never a fixed set", () => {
	containsAll(skills, [
		"Pass only matching exact `Path` values to subagents under `## Skills to load before work`.",
		"Match the delegated task's own files and actions, never a fixed set",
		"a child that will not commit gets no commit skill, and one that writes no docs gets no docs skill",
	], "orchestrator-skills.md");
});

test("S4 continuations: a resumed child skips only material it already read and that did not change; first launch reads stay", () => {
	const continuation =
		"When resumed in the same child session, do not re-read skill files or spec sections you already read there unless they changed or the parent says so; read anything you have not read yet as usual";
	for (const [name, body] of Object.entries(agents)) containsAll(body, [continuation], `gentle-ai-${name}`);
	containsAll(agents.worker, ["Read every exact path under `## Skills to load before work`", "read it from the top until `## Log`"], "worker first launch");
	containsAll(agents.verify, ["read all of it, including the verbatim user entries in `## Log`", "read anything you have not read yet as usual, including new `## Log` entries."], "verify first launch and new Log entries");
	containsAll(agents.explore, ["read it until `## Log` for the requirements"], "explore first launch");
});

test("S4 reports: every child report is compact, cites exact commands with exit codes and counts, and never restates the task", () => {
	const noRestate = "never restate the task, the spec text, or unchanged file contents";
	containsAll(agents.worker, [noRestate], "gentle-ai-worker");
	containsAll(agents.explore, [noRestate], "gentle-ai-explore");
	containsAll(agents.verify, ["never restate the task or spec beyond the line a finding contradicts, or unchanged file contents"], "gentle-ai-verify");
	containsAll(agents.worker, [
		"Return one compact handoff using the schema below; cite exact commands with exit codes and test counts",
		"blockers with `path:line`",
		"scratch paths",
	], "worker report");
	// The existing Return contract fields stay.
	containsAll(agents.worker, [
		"status: completed | partial | blocked | interaction_required",
		"summary:",
		"files_changed:",
		"tdd_evidence:",
		"validation:",
		"risks:",
		"review_focus:",
		"skill_resolution: paths-injected | paths-invalid | none",
		"unblock_response:",
	], "worker Return contract");
	containsAll(agents.verify, [
		"Return a compact evidence handoff of at most ~2k tokens",
		"exact commands with exit codes, test counts, and observed results",
		"the verdict per spec item",
		"blockers with `path:line`",
		"scratch paths",
		"Never claim a command ran or a check passed without observed output.",
	], "verify report");
	containsAll(agents.explore, ["Return a compact handoff of at most ~2k tokens", "`path:line`", "Never claim evidence you did not observe."], "explore report");
	// The parent's Key Learnings closing block still follows the Return contract.
	for (const [name, body] of Object.entries(agents)) containsAll(body, ["`## Key Learnings`"], `gentle-ai-${name}`);
});

test("S4 verifier setup pitfalls: clean env, short scratch, one file per config role, flag check, no executing entry points", () => {
	containsAll(agents.verify, [
		"Setup pitfalls:",
		"start every probe from a clean environment so parent-session variables do not leak",
		"set `HOME` and `TMPDIR` inside the scratch directory",
		"keep the scratch path short",
		"give each config role its own file",
		"check that a flag exists for the exact subcommand before using it",
		"never import or execute an entry point just to inspect it",
		// PR #3084 setup self-correction stays.
		"make exactly one corrected attempt without asking anyone and report both attempts",
	], "verify setup pitfalls");
});

test("S4 verifier env applies to every probe", () => {
	assert.match(agents.verify, /NO_UPDATE_NOTIFIER=1`?[^.;]*for every probe|env -i`[^)]*NODE_COMPILE_CACHE[^)]*NO_UPDATE_NOTIFIER/);
});

test("S4 continuation never blocks unread material", () => {
	for (const body of Object.values(agents)) assert.doesNotMatch(body, /; read only what the follow-up names\./);
});

test("S4 worker presents the derived edit-surface candidates as the answer, not an example", () => {
	assert.ok(agents.worker.includes("in `options` as the derived answer, not an example,"), "worker interaction contract lost the derived-answer nuance");
});
