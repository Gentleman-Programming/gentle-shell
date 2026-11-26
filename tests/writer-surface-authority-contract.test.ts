import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// harness-continuity S5 (T4, Pi consumer): the writer never self-authorizes its edit
// surface; the parent adjudicates a necessary same-objective route, and real authority
// changes still reach the human. These are instruction-delivery contracts over the shipped
// lazy writer card, the generated full delegation card, and the packaged worker agent.
// They are not proof of model adherence, and the runtime enforces no filesystem confinement.

const REPO_ROOT = join(import.meta.dirname, "..");
const ASSETS = join(REPO_ROOT, "assets");
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");
const { renderFullDelegationCard } = await import("../scripts/build-full-delegation-card.mjs");

/** The body of one heading, up to the next heading of the same or a higher level. */
function sectionOf(source: string, heading: string): string {
	const lines = source.split("\n");
	const start = lines.indexOf(heading);
	assert.notEqual(start, -1, `missing heading: ${heading}`);
	const level = heading.match(/^#+/)?.[0].length ?? 0;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => {
		const match = line.match(/^(#{1,6}) /);
		return match !== null && match[1].length <= level;
	});
	return rest.slice(0, end === -1 ? undefined : end).join("\n");
}

function containsAll(text: string, clauses: readonly string[], label: string): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `${label} is missing: ${clause}`);
}

const SURFACES = "#### Allowed edit surfaces (MANDATORY)";
const parentSurfaces: Record<string, string> = {
	"orchestrator-writer.md": sectionOf(read("assets/orchestrator-writer.md"), SURFACES),
	"orchestrator-full-delegation-card.md": sectionOf(read("assets/orchestrator-full-delegation-card.md"), SURFACES),
	"rendered full delegation card": sectionOf(renderFullDelegationCard(ASSETS) as string, SURFACES),
};
const worker = read("assets/agents/gentle-ai-worker.md");
const workerContext = sectionOf(worker, "## Context contract");
const workerRules = sectionOf(worker, "## Implementation rules");
const workerInteraction = sectionOf(worker, "## Interaction contract");

test("S5: the writer never widens its own surface and waits for the parent's replacement", () => {
	for (const [label, text] of Object.entries(parentSurfaces)) {
		containsAll(text, [
			"A writer never widens its surface; it reports exact candidate paths with reasons and awaits your replacement.",
		], label);
	}
	containsAll(workerContext, [
		"Never widen it yourself: report a route beyond it to the parent with exact candidate paths and reasons, and wait; only a parent-issued replacement of that section authorizes it",
	], "worker Context contract");
});

test("S5 positive: the parent adds a necessary test or helper path inside the authorized objective and repository", () => {
	for (const [label, text] of Object.entries(parentSurfaces)) {
		containsAll(text, [
			"Add a necessary path (test, helper) yourself, without the human, only in the authorized objective and repository, after checking ownership, existing work, risk, and concurrent writers and units",
		], label);
	}
	containsAll(workerRules, [
		"the parent decides whether it is a technical extension inside the same authorized objective, which it may approve itself, or a real human choice",
	], "worker Implementation rules");
});

test("S5 negative: refactor-only scope and an unresolved ownership or overlap conflict are never added", () => {
	for (const [label, text] of Object.entries(parentSurfaces)) {
		containsAll(text, [
			"a cosmetic refactor never qualifies",
			"an unresolved ownership or overlap conflict blocks it",
		], label);
	}
});

test("S5 negative: another repository, private data, and real authority changes still reach the human", () => {
	for (const [label, text] of Object.entries(parentSurfaces)) {
		containsAll(text, [
			"New objective or scope, unapproved repository, private material, destructive or prohibited operation, missing consent, denial, or exhausted limit go to the human under existing protocols.",
			"A surface grants no repository authority or prohibited operation.",
		], label);
	}
	containsAll(workerContext, [
		"That section never substitutes for repository or worktree authority and never authorizes an operation the rules prohibit.",
	], "worker Context contract");
});

test("S5: a continuation keeps the same writer and replaces, never unions, the surface", () => {
	for (const [label, text] of Object.entries(parentSurfaces)) {
		containsAll(text, [
			"Continue the same writer with a replacement, not a union: every still-needed path plus a concise reason, never repository-wide, no budget reset.",
		], label);
	}
	containsAll(workerContext, ["carrying every still-needed path because the replacement is not a union"], "worker Context contract");
});

test("S5: technical route uncertainty is investigated, and derive-first exact-path rules stay", () => {
	for (const [label, text] of Object.entries(parentSurfaces)) {
		containsAll(text, [
			"Investigate technical route doubt; it is not a human question.",
			"do not launch or make the human author paths: offer the derived exact paths as an approve/decline choice",
			"exact repository-relative paths or narrow globs, one per line; never `.` and never a bare repository root",
			"pre-existing untracked targets it may write, listed explicitly",
			"plus directories where it authorizes new files",
		], label);
	}
	containsAll(workerContext, ["pre-existing untracked targets explicitly listed by the parent", "new files required by the delegated task"], "worker Context contract");
	containsAll(workerInteraction, [
		"each with its reason, and ask the parent to approve that list, narrow it, or route it to the human",
		"never ask anyone to author paths, globs, identifiers, or commands as free text",
	], "worker Interaction contract");
});

test("S5: the retired human-only surface wording is gone and no confinement is claimed", () => {
	for (const [label, text] of Object.entries(parentSurfaces)) {
		assert.ok(!text.includes("add or drop paths only on the human's explicit instruction"), `${label} keeps the human-only surface rule`);
		assert.doesNotMatch(text, /sandbox|confine/i, `${label} claims filesystem confinement`);
		// Verifier probes (mwi607f7-18-0crn): the retired relay rule stays gone, and refusal is behavior, not a guarantee.
		assert.ok(!text.includes("Relay a writer's"), `${label} keeps the retired relay rule`);
		assert.doesNotMatch(text, /never writes outside/, `${label} states surface refusal as a guarantee`);
	}
	for (const retired of [
		"a derived candidate set the human can approve or narrow",
		"ask the human to approve that list or name which entries to drop",
		"When any human input is required, stop editing",
	]) {
		assert.ok(!worker.includes(retired), `the worker keeps the human-only surface wording: ${retired}`);
	}
	assert.doesNotMatch(worker, /sandbox|confine/i, "the worker claims filesystem confinement");
});

// fix/temp-dir-exemption (user decision: temp folders are exempt; read, write and delete only what the
// session or its tools created): an in-surface atomic replace and a tool's own temp cleanup are not stops.
const workerToolSafety = sectionOf(worker, "## Tool safety");

test("temp exemption: replacing a file inside the surfaces, atomic write-temp-then-rename included, is an ordinary write", () => {
	containsAll(workerToolSafety, [
		"Replacing a file inside your allowed edit surfaces, including a tool's atomic write-temp-then-rename, is an ordinary write of that surface, not the prohibited filesystem replacement.",
	], "worker Tool safety");
});

test("temp exemption: a task tool may create and remove its own temp files without a stop or question", () => {
	containsAll(workerToolSafety, [
		"A tool you run for the task may create and remove its own files in the system temp directory (resolved `TMPDIR`/`os.tmpdir()`, `/tmp`, `/var/tmp`), such as test scratch, caches, or a browser's temporary profile; do not stop or ask for that.",
	], "worker Tool safety");
});

test("temp exemption preserves the outside-surface write, replacement and deletion prohibitions", () => {
	containsAll(workerToolSafety, [
		"- Never write outside the exact allowed edit surfaces, including through generated output, shell redirection, temporary copies, formatters, or scripts.",
		"- Never run destructive commands or deletion operations. This includes `rm`, filesystem replacement, destructive migrations, and destructive Git commands",
		"Replacing or deleting anything else stays prohibited, and you never run `rm` or delete scratch yourself.",
	], "worker Tool safety");
	containsAll(worker, ["name any that remains in `risks` instead of deleting it"], "worker scratch reporting");
	const tempBullet = workerToolSafety.split("\n").find((line) => line.startsWith("- Replacing a file inside your allowed edit surfaces")) ?? "";
	assert.ok(tempBullet.includes("never run `rm`"), "the worker temp bullet must keep the worker itself from running rm");
});
