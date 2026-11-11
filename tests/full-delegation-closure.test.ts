import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// ---------------------------------------------------------------------------
// full-delegation-mode-conflicts S2/S3/S4/S6/S8.
//
// In full delegation mode the organic routing rules are removed from what the
// orchestrator can read, never annotated as "does not apply": a rule left in
// context is a rule a model may follow. This file pins that closure over the
// whole always-on prompt AND every lazy asset it names, so the day the mirrored
// provider contract or a shared asset reintroduces an inline-first rule, this
// test fails instead of a user's session deadlocking.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..");
const ASSETS = join(REPO_ROOT, "assets");
const { __testing } = await import("../extensions/gentle-ai.ts");

/**
 * Phrases that route work inline, or decide delegation by size. "Task Size" is deliberately absent: it defines
 * tracking and risk in both modes, and the full delegation core keeps that section.
 */
const ORGANIC_ROUTING = /\binline\b|small path|small edits|never delegates|Writer (?:rule|trigger)/i;

test("S6: the closure rule recognises the organic sentences a narrower pattern let through", () => {
	// Independent verification B1: each of these, inserted into a reachable asset, passed an earlier,
	// phrase-by-phrase pattern. Any "inline" now fails the closure, with no allowlist to maintain.
	for (const sentence of [
		"Units of about 100 changed lines or less always run inline: the parent edits them.",
		"Without a reason, the parent works inline, following the logbook.",
		"Is the change small? If no, delegate it. If no, do it inline.",
		"Small task pattern: parent edits inline, then reports.",
		"6. **Implement task by task.** Implement inline unless a trigger fires.",
		"A large task alone never delegates.",
	]) {
		assert.ok(ORGANIC_ROUTING.test(sentence), sentence);
	}
});

function render(mode: "organic" | "full-delegation"): string {
	return __testing.buildGentlePrompt("gentleman", REPO_ROOT, undefined, undefined, undefined, mode);
}

function namesIn(text: string): string[] {
	return [...new Set([...text.matchAll(/orchestrator(?:-[a-z]+)*\.md/g)].map((match) => match[0]))];
}

/** Every lazy asset reachable from the prompt: named by it, or by an asset it names, transitively. */
function namedAssets(prompt: string): string[] {
	const reached = new Set<string>();
	const pending = namesIn(prompt);
	while (pending.length > 0) {
		const name = pending.pop()!;
		if (reached.has(name)) continue;
		reached.add(name);
		const path = join(ASSETS, name);
		if (existsSync(path)) pending.push(...namesIn(readFileSync(path, "utf8")));
	}
	return [...reached].sort();
}

function organicLines(text: string): string[] {
	return text.split("\n").filter((line) => ORGANIC_ROUTING.test(line));
}

test("S2/S6: the full delegation prompt carries no organic routing rule", () => {
	assert.deepEqual(organicLines(render("full-delegation")), []);
});

test("S2/S6: no lazy asset reachable from the full delegation prompt carries an organic routing rule", () => {
	const named = namedAssets(render("full-delegation"));
	assert.ok(named.length > 0, "the prompt must still point at its lazy detail");
	for (const name of named) {
		const path = join(ASSETS, name);
		assert.ok(existsSync(path), `the prompt names a lazy asset that does not exist: ${name}`);
		assert.deepEqual(organicLines(readFileSync(path, "utf8")), [], `${name} reaches a full delegation session`);
	}
});

// cost-speed P6 (X9): the full delegation parent gets tracking and verification detail from modules that are clean
// for a parent that never implements, and the parallel-launch form inline in its own prompt, never through the
// organic writer or delegation cards.
test("P6 (X9): full delegation reaches tracking and verification, not the organic writer cards, and states the launch rules", () => {
	const prompt = render("full-delegation");
	const named = namedAssets(prompt);
	for (const name of ["orchestrator-tracking.md", "orchestrator-verification.md"]) assert.ok(named.includes(name), `the closure must reach ${name}`);
	for (const name of ["orchestrator-writer.md", "orchestrator-delegation.md", "orchestrator-delegation-reference.md", "orchestrator.md"]) assert.ok(!named.includes(name), `the closure must not reach ${name}`);
	assert.ok(prompt.includes("tracked work: `orchestrator-tracking.md`"));
	assert.ok(prompt.includes("verification, handoffs, verifier setup failure: `orchestrator-verification.md`"));
	assert.ok(prompt.includes(PARALLEL_LAUNCH_RULE), "the parallel-launch sentence");
	assert.ok(prompt.includes("Fixes to one unit continue its worker (`subagent_continue`), never a new worker per fix."));
});

// cost-speed P6b: "in one message with no other tool call" read as "each call in a message of its own" (F3: three
// writers in three messages, no overlap, 887-1,092 s vs 393-478 s from one codemode script). Both routes are admitted
// and overlap in full delegation (real Pi probes); the sequential tools are those declaring `executionMode: "sequential"`.
const PARALLEL_LAUNCH_RULE = "Independent units with disjoint surfaces launch together: all their `subagent_run` calls in the same assistant message or one `codemode` script, never one launch per message nor beside a sequential `todo`, `ask_user_*`, `codegraph` or `gentle_review*` (it serializes them); units needing the same file run one at a time.";

test("P6b: full delegation launches independent units in the same assistant message or one codemode script, never one per message", () => {
	const prompt = render("full-delegation");
	assert.ok(prompt.includes("in the same assistant message"), "same assistant message");
	assert.ok(prompt.includes("or one `codemode` script"), "codemode route");
	assert.ok(prompt.includes("never one launch per message"), "never one launch per message");
	for (const tool of ["`todo`", "`ask_user_*`", "`codegraph`", "`gentle_review*`"]) assert.ok(prompt.includes(tool), `sequential tool ${tool}`);
	assert.ok(!prompt.includes("in one message with no other tool call"), "the ambiguous clause is gone");
	assert.ok(!prompt.includes("as direct `subagent_run` calls"), "codemode is no longer excluded");
});

test("S3: full delegation keeps a Task Size that decides tracking and risk, never who writes", () => {
	const prompt = render("full-delegation");
	assert.match(prompt, /## Task Size/);
	assert.match(prompt, /resume test/i);
	for (const item of ["(1)", "(2)", "(3)", "(4)", "(5)", "(6)"]) assert.ok(prompt.includes(item), `high-risk item ${item} is missing`);
	assert.match(prompt, /Risk line/);
	assert.doesNotMatch(prompt, /small work follows/i);
});

test("S4: full delegation tells the agent how the human switches the mode, and that no new session is needed", () => {
	const prompt = render("full-delegation");
	assert.match(prompt, /\/gentle:profiles/);
	assert.match(prompt, /`w`/);
	assert.match(prompt, /next turn/i);
	assert.match(prompt, /no new session/i);
});

test("S2: the projected ODD steps keep every unchanged step and the shared tail lines byte for byte", () => {
	const organic = render("organic").split("\n");
	const full = render("full-delegation");
	for (const step of ["1. **Authorize.**", "3. **Resolve uncertainty.**", "5. **Track before the first write.**", "7. **Close.**", "Phase reporting: "]) {
		const line = organic.find((candidate) => candidate.startsWith(step));
		assert.ok(line, `organic render lost ${step}`);
		assert.ok(full.includes(line), `full delegation must keep ${step} verbatim`);
	}
	// The resume line is shared too; only its pointer to the organic card is projected.
	const resume = organic.find((candidate) => candidate.startsWith("Resume an interrupted feature "));
	assert.ok(resume?.includes("`orchestrator-delegation.md`"));
	assert.ok(full.includes(resume!.replace("`orchestrator-delegation.md`", "`orchestrator-full-delegation-card.md`")), "resume keeps every byte but its pointer");
	for (const step of ["2. **Explore.**", "4. **Classify.**", "6. **Implement task by task.**"]) {
		assert.ok(full.split("\n").some((line) => line.startsWith(step)), `full delegation must keep a step ${step}`);
	}
});

test("S8: the organic render still carries the mirrored steps unprojected", () => {
	const organic = render("organic");
	assert.match(organic, /4\. \*\*Classify\.\*\* Size the task by the orchestrator's Task Size section; its criteria and resume test alone decide small or large, and small work follows its small path\./);
	assert.match(organic, /when in doubt, work inline/);
	assert.match(organic, /`orchestrator-delegation-reference\.md`/);
});

test("S2: the full delegation card is up to date with the organic sources it projects", async () => {
	const { renderFullDelegationCard, FULL_DELEGATION_CARD } = await import("../scripts/build-full-delegation-card.mjs");
	assert.equal(
		readFileSync(join(ASSETS, FULL_DELEGATION_CARD), "utf8"),
		renderFullDelegationCard(ASSETS),
		"run node scripts/build-full-delegation-card.mjs --write",
	);
});

