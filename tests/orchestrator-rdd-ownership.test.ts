import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const ASSETS = join(ROOT, "assets");
const BOUNDARY =
	"This package injects the mirrored provider-bundle review execution contract into this session's system prompt at start; Gentle AI writes nothing into the Pi system prompt, and this package owns everything else here. Absent that mirrored contract, this package invents no lifecycle instructions.";

function read(relativePath: string): string {
	return readFileSync(join(ROOT, relativePath), "utf8");
}

const core = read("assets/orchestrator.md");
const delegation = read("assets/orchestrator-delegation.md");
const staticPrompts = `${core}\n${delegation}`;

test("static prompts omit stale native RDD lifecycle mirrors", () => {
	for (const marker of [
		"Authority-First Terminal Procedure",
		"reconcile-terminal-mirrors",
		"Native Bounded Review Orchestration",
		"Continue after a stop reason code",
		"gentle-ai review status",
		"next_transition",
		"start -> finalize -> validate",
		"review.capture-result",
		"review.validate",
		"reviewGate.result",
	]) {
		assert.ok(!staticPrompts.includes(marker), `stale RDD marker remains: ${marker}`);
	}
});

test("lossless blocking prompts route every closed single-select envelope through the native closed tool", () => {
	for (const clause of [
		"For every strictly closed single-select envelope",
		"ask_user_choice",
		"envelope-owned canonical option token as opaque `value`",
		"returns exactly one `value`",
		"externally owned open/free-text questionnaire",
		"never for a closed domain",
		"exact captured provider-owned choice invocation",
	]) {
		assert.ok(delegation.includes(clause), `lossless prompt is missing: ${clause}`);
	}
});

test("static prompts declare one dynamic Gentle AI RDD ownership boundary", () => {
	assert.equal(staticPrompts.split(BOUNDARY).length - 1, 1, "expected one dynamic RDD ownership boundary");
	assert.ok(core.includes(BOUNDARY), "the Pi parent prompt owns the single boundary");
	assert.ok(!delegation.includes(BOUNDARY), "generic delegation detail must not gain RDD text");
});

test("rendered parent prompt keeps the RDD boundary while omitting lifecycle mirrors", async () => {
	const { __testing } = await import("../extensions/gentle-ai.ts");
	const rendered = __testing.getOrchestratorPrompt();
	assert.ok(rendered.includes(BOUNDARY));
	for (const marker of ["Authority-First Terminal Procedure", "reconcile-terminal-mirrors", "next_transition"]) {
		assert.ok(!rendered.includes(marker), `rendered parent prompt leaked: ${marker}`);
	}
	// gentle-pi#661: getOrchestratorPrompt()'s no-argument default renders the
	// "unknown (native status unavailable)" RDD status line -- the longest of
	// the three renderable forms -- so this IS the worst-case render the 8 KiB
	// budget below must cover, not a smaller placeholder production later
	// exceeds.
	assert.ok(
		rendered.includes("Receipt-driven development: unknown (native status unavailable)"),
		"the default render must include the worst-case RDD status line",
	);
	assert.ok(Buffer.byteLength(rendered, "utf8") <= 8192, "the rendered parent prompt must stay below the reduced 8 KiB budget");
});

test("static prompts retain ODD and delegated-work guidance without SDD", () => {
	for (const heading of ["## Memory Contract", "## Work Routing Ladder"]) {
		assert.ok(core.includes(heading), `core lost ${heading}`);
	}
	for (const heading of [
		"### Delegation Rules",
		"#### Background Subagent Policy",
		"#### Allowed edit surfaces (MANDATORY)",
	]) {
		assert.ok(delegation.includes(heading), `delegation lost ${heading}`);
	}
	assert.doesNotMatch(staticPrompts, /SDD|sdd-|OpenSpec|openspec/i);
});

test("always-on parent prompt requires a narrow writer edit surface before launch", () => {
	assert.match(core, /Before launching (?:a )?bounded writer/i);
	assert.match(core, /`gentle-ai-worker`/);
	assert.match(core, /`worker`/);
	assert.match(core, /## Allowed edit surfaces/);
	assert.match(core, /repository-relative/i);
	assert.match(core, /never `\.`|never a bare repository root/i);
	assert.match(core, /do not ask the human to author paths or globs/i);
});

test("review integration documents the in-process reviewer completion and Go-owned authority boundary", () => {
	const docs = read("docs/review-integration.md");
	for (const marker of [
		"no child process",
		"exact Go-issued materialize/submission tokens",
		"typed reviewer refusal fails closed",
		"Go owns worktree, lineage, candidate freeze, lens selection, correction, validator, approval burn, and review semantics",
		"Delivery commands remain ordinary repository-policy operations.",
		"package has no durable receipt or policy authority",
		"static assets intentionally omit lifecycle instructions",
	]) {
		assert.ok(docs.includes(marker), `review integration doc is missing: ${marker}`);
	}
});
