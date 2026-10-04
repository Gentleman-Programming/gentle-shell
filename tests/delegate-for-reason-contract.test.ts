import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { HIGH_RISK_ITEMS } from "../lib/review-risk-assessment.ts";
import { readDelegationDetail } from "./support/orchestrator-modules.ts";

// gentle-shell#1731: the delegated writer fires on named reasons (parallelism,
// context), never on task size. A large task keeps the ODD logbook (#1494
// resume test) and works inline when no reason fires. T24 (L49) turned the
// cost reason off: a price ratio never fires the Writer rule, while configured
// per-agent model routing still applies to writers launched for other reasons.
// These are instruction-delivery contracts, not proof of model adherence.

const read = (relative: string): string => readFileSync(join(import.meta.dirname, "..", relative), "utf8");
const core = read("assets/orchestrator.md");
const delegation = readDelegationDetail();
const writer = read("assets/orchestrator-writer.md");
const verification = read("assets/orchestrator-verification.md");
const skill = read("skills/gentle-ai/SKILL.md");

function lineStarting(text: string, prefix: string): string {
	const line = text.split("\n").find((entry) => entry.startsWith(prefix));
	assert.ok(line, `missing line starting with: ${prefix}`);
	return line;
}

const coreWriter = lineStarting(core, "5. **Writer rule**");
const delegationWriter = lineStarting(delegation, "5. **Writer trigger (Writer rule):**");

test("AC1: the core writer rule fires on named reasons, never on size or file count", () => {
	for (const clause of [
		"never by file count or a large task alone",
		"`orchestrator-writer.md`",
		"2+ independent units, disjoint files, each heavier than a subagent start",
		"Context backstop",
	]) {
		assert.ok(coreWriter.includes(clause), `core Writer rule is missing: ${clause}`);
	}
	assert.ok(!core.includes("large task → one bounded `gentle-ai-worker` per task"), "core keeps the size-based writer rule");
	assert.ok(
		core.includes("large tasks get ODD tracking and workers only by the Writer rule, else inline"),
		"core Task Size must keep tracking for large tasks and run them inline without a writer reason",
	);
});

test("AC1: the lazy writer trigger names its reasons and keeps the logbook on the inline path", () => {
	for (const clause of [
		"a large task alone never delegates, and file count never fires this trigger",
		"Delegate one bounded writer per unit only for a named reason",
		"(a) parallelism",
		"(b) context",
		"Without a reason, the parent works inline, following the logbook (feature document, mirror, `todo`, work-unit commits)",
	]) {
		assert.ok(delegationWriter.includes(clause), `lazy Writer trigger is missing: ${clause}`);
	}
	for (const [path, text] of Object.entries({ delegation, writer, skill })) {
		assert.ok(!text.includes("a large task delegates one bounded writer per task"), `${path} keeps the size-based writer trigger`);
		assert.ok(!text.includes("one writer per task"), `${path} keeps one writer per task`);
		assert.ok(!text.includes("a large task (track and writer)"), `${path} still fires the writer on size`);
	}
	assert.ok(writer.includes("never on size alone"), "the writer module must say the Writer rule never fires on size alone");
	assert.ok(skill.includes("a writer reason (parallel units or context)"), "the skill must name the writer reasons");
});

test("AC2: parallelism needs 2+ independent units, disjoint files, each heavier than a subagent start", () => {
	assert.ok(
		delegationWriter.includes(
			"(a) parallelism — 2+ independent units with disjoint files, each clearly heavier than starting a subagent; medium tasks included",
		),
		"lazy Writer trigger must state the parallelism threshold",
	);
	assert.ok(writer.includes("parallel units"), "the writer module must name the parallelism reason");
});

test("T24/L49: a price ratio no longer fires the Writer rule", () => {
	assert.doesNotMatch(coreWriter, /ratio|price|Model routing|small path/i, "core Writer rule still fires on cost");
	assert.ok(!core.includes("Model routing:"), "the orchestrator core never carries the fact line");
	const intro = lineStarting(writer, "Parent Pi session only.");
	assert.ok(intro.includes("The Writer rule fires on a named reason (parallel units, the context backstop), never on size alone or a price ratio"), "the writer module must name only the remaining reasons");
	assert.doesNotMatch(writer, /about 3x|price ratio of|- \*\*Model routing\*\*/, "the writer module keeps the cost reason");
	// T24 follow-up: no surface names the price ratio as a writer reason.
	for (const [path, text] of Object.entries({ delegationWriter, skill, readme: read("docs/readme-reference.md") })) {
		assert.doesNotMatch(text, /model routing —|price ratio of about 3x/, `${path} still names the cost reason`);
	}
});

test("T24/L49: configured per-agent model routing still applies to writers launched for other reasons", () => {
	const intro = lineStarting(writer, "Parent Pi session only.");
	assert.ok(intro.includes("Configured per-agent models (`subagents.json` `model_profiles`) still apply to every writer it launches."), "the writer module must keep configured routing");
	assert.ok(
		delegation.includes("Let `pi-subagents` resolve model and thinking from `.pi/settings.json`, `.pi/subagents.json`, global subagent config, and runtime defaults."),
		"delegated launches must keep resolving configured models",
	);
});

test("AC4: verification stays risk-gated and the writer reasons never include risk", () => {
	assert.ok(
		core.includes(
			"3. **Verification rule** — high risk → independent `gentle-ai-verify` after the change's own checks (`orchestrator-verification.md`); otherwise checks run inline.",
		),
		"core Verification rule changed",
	);
	assert.ok(
		delegation.includes(
			"3. **Verification rule** (gentle-pi#661/#662, RDD-aware): a high-risk change (Task Size) gets an independent `gentle-ai-verify` run after the change's own checks; otherwise whoever made the change runs its focused test and suite inline, small tasks included.",
		),
		"lazy Verification rule changed",
	);
	for (const [label, text] of Object.entries({ coreWriter, delegationWriter })) {
		assert.ok(!/high risk|high-risk|verify/i.test(text), `${label} mixes risk or verification into the writer reasons`);
	}
	assert.ok(!writer.includes("(1) data or irreversible effects"), "the writer module restates the high-risk list");
});

// T3 (S5-S7, AC5): the parallel review protocol lives in the lazy verification
// module, so it loads only when delegation happens.
function sectionFrom(text: string, heading: string): string {
	const start = text.indexOf(heading);
	assert.ok(start >= 0, `missing section: ${heading}`);
	const next = text.indexOf("\n## ", start + heading.length);
	return text.slice(start, next < 0 ? undefined : next + 1);
}

const reviewSection = (): string => sectionFrom(verification, "## Parallel review protocol (gentle-shell#1731)");

function reviewItem(prefix: string): string {
	return lineStarting(reviewSection(), prefix);
}

test("AC5/S5: every worker self-reviews against the spec by reference before returning", () => {
	const item = reviewItem("1. **Self-review**");
	for (const clause of [
		"in its own session before returning",
		"spec sections by reference (#1713)",
		"the request's authorized examples, tests, and typecheck",
		"fixes and continues",
		"requirement by requirement",
		"Low and medium risk need nothing else.",
	]) {
		assert.ok(item.includes(clause), `self-review item is missing: ${clause}`);
	}
	assert.ok(writer.includes("Parallel review protocol") && writer.includes("`orchestrator-verification.md`"), "the writer module must point at the review protocol");
});

test("AC5/S6/L4: per-worker independent verify fires only on assess or escalate, never on the summary alone", () => {
	const item = reviewItem("2. **Independent verify per unit**");
	for (const clause of [
		"in parallel when several finish together",
		"only when that unit is high risk",
		"`assess` over its actual diff",
		"the worker's own `escalate`",
		"never inferred from the worker's summary alone",
		'its work-unit commit (`{"baseRef":"<previous>","committedOnly":true}`)',
		"its own isolated worktree",
	]) {
		assert.ok(item.includes(clause), `independent verify item is missing: ${clause}`);
	}
	assert.ok(!reviewSection().includes("(1) data or irreversible effects"), "the protocol restates the high-risk list instead of referencing it");
	assert.ok(item.includes("high-risk list in Task Size"), "the protocol must reference the core high-risk list");
});

test("AC5/S7: one inline full-suite seam check after parallel units", () => {
	const item = reviewItem("3. **Seam check**");
	for (const clause of ["after parallel units finish", "one inline full-suite command", "parent spot check", "seams between units"]) {
		assert.ok(item.includes(clause), `seam check item is missing: ${clause}`);
	}
});

// T12 (S4, S6; L24): in the bench verify ran once per worker cycle instead of
// once per unit, and a parent scoped it to "T1 only".
test("T12/S6: one independent verify per delegated unit after its self-review, never per worker cycle", () => {
	const item = reviewItem("2. **Independent verify per unit**");
	for (const clause of [
		"once, after its final self-review",
		"never per worker cycle or retry",
		"its Risk line",
		"small-model bias per the tier table",
	]) {
		assert.ok(item.includes(clause), `independent verify timing is missing: ${clause}`);
	}
	assert.ok(!item.includes("(1) "), "the timing rule restates the high-risk list");
});

// T15 (S6, L38): after3 B x4 paid two same-model verifies with 0 defects,
// while verify caught real defects in smaller-model (Luna) writer code.
test("T15/S6: same-model inline code over several deliveries gets one verify at the feature's end; smaller-model writer code stays per unit", () => {
	const item = reviewItem("2. **Independent verify per unit**");
	for (const clause of [
		"Same-model inline code over several deliveries of one feature",
		"one verify at the feature's end",
		"smaller-model writer code stays per unit",
		"only when that unit is high risk",
		"small-model bias per the tier table",
	]) {
		assert.ok(item.includes(clause), `independent verify exception is missing: ${clause}`);
	}
});

test("T11/S4: the parent hands verify the whole spec, authorizes its probes and resolves every unmet item", () => {
	const item = reviewItem("4. **Verify handoff**");
	for (const clause of [
		"the whole feature document",
		"every `S#`, never one task",
		"the baseline commit",
		"probes on isolated state",
		"typecheck",
		"`gentle-ai-verify` holds the checklist",
		"every unmet item before closing",
		"the writer commits its probes as regression tests",
	]) {
		assert.ok(item.includes(clause), `verify handoff item is missing: ${clause}`);
	}
});

test("AC4/S4: the normative verification rule text is unchanged by the review protocol", () => {
	const normative = sectionFrom(verification, "## Verification rule (normative)");
	assert.equal(
		createHash("sha256").update(normative).digest("hex"),
		"decd9979faa4f6329df9b8fec16d69230428f14d116edff136f1bee2f540a888",
		"the normative Verification rule section changed",
	);
	assert.ok(verification.includes("or a delegated writer returns"), "the module must still load when a delegated writer returns");
});

test("S1: the small path stays inline and no lazy surface keeps the size-based writer route", () => {
	assert.ok(core.includes("No explore, worker, or verifier"), "small path must stay inline");
	assert.ok(!delegation.includes("| Write a large (tracked) task | — | ✅ one writer per task |"), "delegation table keeps the size-based writer row");
	assert.ok(delegation.includes("| Write a large task with no Writer rule reason | ✅ following the logbook | — |"), "delegation table must route a reasonless large task inline");
	assert.ok(!delegation.includes("implementing a large tracked task (writer)"), "Simple Delegation keeps the size-based writer route");
});

// T7-T9 (L14): the bench showed the rules decide WHETHER to delegate but not
// HOW. T7 forces a risk declaration on every code change, small path included,
// so it lives in the always-on core. T9 binds how the parallelism reason
// launches writers, so it lives in the lazy writer module (T24 retired T8's
// cost-reason launch rule with the cost reason itself).
const taskSize = sectionFrom(core, "## Task Size");

test("T7/AC4: every code change closes with a forced risk line that routes any listed item to independent verify", () => {
	const rule = lineStarting(taskSize, "**Risk line**");
	for (const clause of [
		"close every code change, small path or delegated",
		"`Risk: item N (reason)`",
		"`Risk: none`",
		"per the list",
		"any item → Verification rule",
	]) {
		assert.ok(rule.includes(clause), `risk line rule is missing: ${clause}`);
	}
	const highRisk = taskSize.indexOf("**High risk**");
	assert.ok(highRisk >= 0 && taskSize.indexOf("**Risk line**") > highRisk, "the risk line must follow the high-risk list it is checked against");
	// The small path loads no lazy module, so the rule must render in the always-on prompt.
	assert.ok(__testing.getOrchestratorPrompt().includes(rule), "the risk line must reach the always-on prompt");
	for (const [path, text] of Object.entries({ delegation, writer, verification })) {
		assert.ok(!text.includes("`Risk: item N (reason)`"), `${path} restates the core risk line`);
	}
});

// T10 (S4, L19-L21): the risk line tagged items 1 and 3 for additive features,
// so verify ran on most tasks. High risk is changing or breaking existing
// things, not adding.
function highRiskItem(n: number): string {
	const list = lineStarting(taskSize, "**High risk**");
	const start = list.indexOf(`(${n}) `);
	const next = list.indexOf(`; (${n + 1}) `, start);
	const end = next >= 0 ? next : list.indexOf(". ", start);
	assert.ok(start >= 0 && end > start, `high-risk item ${n} is missing`);
	return list.slice(start, end);
}

test("T10/AC4: item 1 covers changing stored data or unvalidated writes, not ordinary new records", () => {
	const item = highRiskItem(1);
	for (const clause of ["migrations", "rewriting or deleting stored data", "format changes", "writing data without validation", "not saving new records"]) {
		assert.ok(item.includes(clause), `item 1 is missing: ${clause}`);
	}
	assert.ok(!item.includes("persisted data"), "item 1 keeps the broad persisted-data form");
});

test("T10/AC4: item 3 covers changing or removing consumed contracts, not adding a flag, command or optional field", () => {
	const item = highRiskItem(3);
	assert.ok(item.startsWith("(3) changing or removing contracts others already consume ("), `item 3 is not limited to existing contracts: ${item}`);
	for (const clause of ["public API", "CLI flags", "config formats", "exports", "mirrored prompts", "not adding a flag, command or optional field"]) {
		assert.ok(item.includes(clause), `item 3 is missing: ${clause}`);
	}
});

test("T10: escalate labels name the core high-risk items", () => {
	for (const [n, label] of Object.entries(HIGH_RISK_ITEMS)) {
		assert.ok(highRiskItem(Number(n)).startsWith(`(${n}) ${label}`), `escalate label ${n} drifts from the core list: ${label}`);
	}
});

test("T9/AC2: the parallelism reason launches every unit together in background and waits for all", () => {
	const parallel = lineStarting(writer, "- **Parallelism**");
	for (const clause of [
		"every disjoint unit in the same turn",
		'`subagent_run` with `mode: "background"`',
		"wait for all completions",
		"serial launches void the reason",
		"work inline",
		"Seam check",
	]) {
		assert.ok(parallel.includes(clause), `writer parallelism launch rule is missing: ${clause}`);
	}
	assert.ok(!/high risk|high-risk|verify/i.test(parallel), "parallel mixes risk or verification into the writer reasons");
});

// T4 (S2, AC6): the runtime rejects an overlapping live writer at admission,
// so the single-writer wording relaxes to disjoint surfaces or isolated worktrees.
test("AC6: parallel writers need disjoint Allowed edit surfaces (runtime-enforced) or isolated worktrees", () => {
	const rule = "arallel writers only with disjoint Allowed edit surfaces (runtime-enforced) or isolated worktrees";
	const harness = read("extensions/gentle-ai.ts");
	const docs = read("docs/readme-reference.md");
	assert.ok(core.includes(`- P${rule}.`), "core Safety must carry the relaxed writer rule");
	assert.ok(harness.includes(`- P${rule}.`), "harness principles must carry the relaxed writer rule");
	for (const [path, text] of Object.entries({ core, delegation, harness, skill, docs })) {
		assert.ok(text.includes(rule), `${path} is missing the relaxed writer rule`);
		for (const retired of ["single-threaded", "Never run parallel writers in one worktree", "do not run parallel writers unless isolated worktrees", "preserves a single writer thread", "one writer per task"]) {
			assert.ok(!text.includes(retired), `${path} keeps the single-writer wording: ${retired}`);
		}
	}
});
