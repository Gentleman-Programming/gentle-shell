import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// cost-speed-painpoints S15 P5a: verdicts C7, C9, C12, X1, X3, X10, R1 and C8 (L41) on the always-on
// primary prompt, plus two P4 cuts: the verifier-setup paragraph moves to its lazy module, and RDD-only
// sentences render only while the session's RDD line is not validated off. Every assertion reads the
// rendered primary prompt through the same helper tests/primary-session-prompt.test.ts uses.

const REPO_ROOT = join(import.meta.dirname, "..");
const ASSETS = join(REPO_ROOT, "assets");
const MODES = ["organic", "full-delegation"] as const;
const PERSONAS = ["gentleman", "neutral"] as const;
const ACTIVE_TOOLS = ["read", "bash", "edit", "write", "subagent_run"] as const;
const RDD_LINES = {
	off: "Receipt-driven development: off (decided by global)",
	on: "Receipt-driven development: on (decided by default)",
	unknown: undefined,
} as const;

let scratch: string;
const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
before(() => {
	scratch = mkdtempSync(join(tmpdir(), "p5a-verdicts-"));
	process.env.GENTLE_PI_CONFIG_HOME = join(scratch, "config");
});
after(() => {
	if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
	else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
	rmSync(scratch, { recursive: true, force: true });
});

function render(mode: (typeof MODES)[number], rdd: keyof typeof RDD_LINES = "unknown", persona: (typeof PERSONAS)[number] = "gentleman"): string {
	return __testing.buildGentlePrompt(persona, join(scratch, "project"), ACTIVE_TOOLS, RDD_LINES[rdd], undefined, mode).replaceAll(ASSETS, "/a");
}

function read(relative: string): string {
	return readFileSync(join(REPO_ROOT, relative), "utf8");
}

const ORGANIC_COORDINATOR = "You are a COORDINATOR who executes understood work inline. Maintain one thin conversation thread, delegate only when a Mechanism trigger fires, and synthesize results for the user.";

test("C7: organic is inline by default and no harness bullet says to use subagents when available", () => {
	const organic = render("organic");
	assert.ok(organic.includes(ORGANIC_COORDINATOR), "organic coordinator sentence");
	assert.ok(!organic.includes("not the default executor for substantial work"), "old coordinator sentence must go");
	assert.ok(organic.includes("no trigger holds by default, and when in doubt work inline"), "the inline-by-default trigger rule stays");
	for (const mode of MODES) {
		assert.ok(!render(mode).includes("- Use subagents when available for exploration, planning, implementation, and review"), `[${mode}] harness bullet must go`);
	}
	// The sentence is the full-delegation region anchor: full delegation still replaces the same region.
	const full = render("full-delegation");
	assert.ok(!full.includes(ORGANIC_COORDINATOR), "full delegation must not carry the organic coordinator sentence");
	assert.ok(full.includes("You are a COORDINATOR in full delegation mode: you never implement."), "full delegation variant replaces the region");
	assert.ok(!full.includes("5. **Writer rule**"), "the organic mechanisms are replaced, not appended");
});

test("C9: high-risk item 3 counts changing shared code that unrequested behavior also uses", () => {
	for (const mode of MODES) {
		const prompt = render(mode);
		assert.ok(prompt.includes("requested changes are not; changing shared code that unrequested behavior also uses is)"), `[${mode}] item 3 wording`);
		assert.ok(!prompt.includes("unrequested breaks in shared code are"), `[${mode}] old item 3 wording must go`);
	}
});

test("C12: only workers save memory, and only with a validated project", () => {
	for (const mode of MODES) {
		const prompt = render(mode);
		assert.ok(prompt.includes("With memory, the parent selects context; workers save validated facts when given a project."), `[${mode}] memory contract`);
		assert.ok(!prompt.includes("subagents save discoveries before returning"), `[${mode}] old memory sentence must go`);
	}
});

test("X1: the RDD ownership boundary states the contract is injected only while RDD is not off", () => {
	for (const mode of MODES) for (const rdd of ["off", "on", "unknown"] as const) {
		const prompt = render(mode, rdd);
		assert.ok(prompt.includes("While RDD is not off, this package injects the mirrored provider-bundle review execution contract; Gentle AI writes nothing into this prompt. Absent that mirrored contract, this package invents no lifecycle instructions."), `[${mode}/${rdd}] ownership boundary`);
		assert.ok(!prompt.includes("into this session's system prompt at start"), `[${mode}/${rdd}] false injection claim must go`);
	}
});

test("X3: the background-policy rules pointer names a file that carries them", () => {
	const organic = render("organic");
	assert.ok(organic.includes("; rules: background block, `orchestrator-delegation-reference.md`."), "organic pointer");
	assert.ok(read("assets/orchestrator-delegation-reference.md").includes("<!-- gentle-pi:background-subagents -->"), "the reference carries the background block");
	const full = render("full-delegation");
	assert.ok(full.includes("; rules: the background block in `orchestrator-full-delegation-card.md`."), "full delegation still projects the pointer to its card");
	for (const prompt of [organic, full]) assert.ok(!prompt.includes("delegation background-subagents block"), "dangling pointer must go");
});

test("X10: the review-contract comment names the core budget test without a stale number", () => {
	const source = read("extensions/gentle-ai.ts");
	assert.ok(!source.includes("pinned at an 8192-byte budget"), "stale 8192-byte comment must go");
	assert.ok(source.includes("that core prompt has its own byte budget (tests/orchestrator-budget.test.ts)."), "comment names the budget test");
});

const STOP_RDD = "- When the user asks to stop receipt-driven development, run `gentle-ai review mode disable` without arguing, working around it, or proposing alternatives first; never enable it unless the user explicitly asks.";

test("R1: the user's request to stop RDD runs disable, in every mode and RDD state, without asserting a default", () => {
	for (const mode of MODES) for (const rdd of ["off", "on", "unknown"] as const) for (const persona of PERSONAS) {
		const prompt = render(mode, rdd, persona);
		assert.equal(prompt.split(STOP_RDD).length - 1, 1, `[${mode}/${rdd}/${persona}] stop-RDD rule once`);
		assert.doesNotMatch(prompt, /(on|off) by default and opt-(out|in)|RDD is (on|off) by default/i, `[${mode}/${rdd}/${persona}] no default asserted`);
	}
});

test("C8: the parallel Writer reason is launched together in one turn, background only when that mode is on", () => {
	const rule = render("organic").split("\n").find((line) => line.startsWith("5. **Writer rule**")) ?? "";
	assert.ok(rule.includes("launched together in one turn (in background when background mode is on), else inline; Context backstop."), "parallel reason wording");
	assert.ok(!rule.includes("launched together in background, else inline"), "background must not be the condition");
	for (const kept of ["never by file count or a large task alone", "2+ independent units of behavior, each heavier than a subagent start", "Small module or command changes stay inline, even when independent", "dependent deliveries are not independent", "`orchestrator-writer.md`"]) {
		assert.ok(rule.includes(kept), `Writer rule keeps: ${kept}`);
	}
});

const SETUP_SENTENCES = [
	"A failed verifier setup is a preparation failure, not an unavailable verifier capability.",
	"If setup fails before probes, preserve the failed attempt and report zero tests run; the checks remain unverified.",
	"After a setup prerequisite is repaired, the human may explicitly request one new bounded verification attempt.",
	"This is a new request, not an automatic retry; it does not reset the prior attempt or unrelated budgets.",
	"Before proceeding, confirm no child is active or has an uncertain status.",
	"Never bypass consent, a denial, explicit one-run or no-retry limits, terminal native outcomes, or exhausted native budgets",
];

test("P4: the verifier-setup paragraph lives in the verification module, not the always-on prompt", () => {
	for (const mode of MODES) for (const rdd of ["off", "on", "unknown"] as const) {
		const prompt = render(mode, rdd);
		assert.ok(!prompt.includes("A failed verifier setup is a preparation failure"), `[${mode}/${rdd}] paragraph must leave the always-on prompt`);
		// The unavailable-verifier rule stays always-on through the mirrored Close step.
		assert.ok(prompt.includes("an unavailable verifier or subagent is reported as unavailable, never retried or escalated into extra ceremony"), `[${mode}/${rdd}] Close step keeps the unavailable-verifier rule`);
	}
	const module = read("assets/orchestrator-verification.md");
	const section = module.slice(module.indexOf("## Verifier preparation failure"), module.indexOf("\n## ", module.indexOf("## Verifier preparation failure") + 1));
	for (const sentence of SETUP_SENTENCES) assert.ok(section.includes(sentence), `module keeps: ${sentence}`);
	assert.ok(section.includes("(one correction in the same verification)"), "self-fix keeps its bound");
	assert.ok(section.includes("on a relaunch, never blindly repeat an oversized copy"), "payload rule keeps its qualifier");
	assert.equal(module.split("A failed verifier setup is a preparation failure").length - 1, 1, "moved once, never duplicated");
});

const RDD_ONLY = [
	"When RDD is on and native assess returns a tier, that tier wins.",
	"An eligible interactive Pi host may resolve `gentle-ai.review-integration.consent/v3` before the envelope reaches the model.",
	"The native review candidate is a work-unit commit or a PR slice, never a TODO checkbox and never the accumulated feature branch; native review runs only under the user-owned RDD switch.",
];

test("P4: RDD-only sentences render only while RDD is not validated off, and the state line always stays", () => {
	for (const mode of MODES) {
		for (const rdd of ["on", "unknown"] as const) {
			const prompt = render(mode, rdd);
			for (const sentence of RDD_ONLY) assert.ok(prompt.includes(sentence), `[${mode}/${rdd}] keeps: ${sentence}`);
		}
		const off = render(mode, "off");
		for (const sentence of RDD_ONLY) assert.ok(!off.includes(sentence), `[${mode}/off] drops: ${sentence}`);
		assert.ok(off.includes("Receipt-driven development: off (decided by global)"), `[${mode}/off] keeps the state line so the user can turn RDD on`);
		assert.ok(off.includes(STOP_RDD), `[${mode}/off] keeps the stop/enable rule`);
		assert.ok(off.includes("High risk"), `[${mode}/off] the high-risk paragraph stays`);
		assert.ok(off.includes("- Never commit unless the user explicitly asks"), `[${mode}/off] the rest of Safety stays`);
	}
	const escalate = "(assess `escalate` when RDD is on or unknown)";
	assert.ok(render("organic", "on").includes(`3. **Verification rule** — only a named high-risk item ${escalate} → independent`), "organic on keeps escalate");
	assert.ok(render("organic", "unknown").includes(escalate), "organic unknown keeps escalate");
	assert.ok(render("organic", "off").includes("3. **Verification rule** — only a named high-risk item → independent `gentle-ai-verify`"), "organic off drops only the escalate clause");
});

// Verifier mwb8aq15-1t-hdan B1: the full-delegation parent launches verifiers too, so it needs a route to the
// verifier-setup rules that left the always-on prompt; it names the section, because the rest of the module
// carries organic wording.
test("P4 B1: the full-delegation parent routes a verifier setup failure to the verification module section", () => {
	for (const rdd of ["off", "on", "unknown"] as const) {
		const verify = render("full-delegation", rdd).split("\n").find((line) => line.startsWith("3. **Verify**")) ?? "";
		assert.ok(verify.includes("add one independent `gentle-ai-verify` only when the Risk line names a high-risk item"), `[${rdd}] verifier sentence stays`);
		assert.ok(verify.includes("; verification, handoffs, verifier setup failure: `orchestrator-verification.md` (`## Verifier preparation failure`)."), `[${rdd}] setup-failure route`);
	}
	const module = read("assets/orchestrator-verification.md");
	const start = module.indexOf("## Verifier preparation failure");
	const section = module.slice(start, module.indexOf("\n## ", start + 1));
	assert.ok(start >= 0 && !/\binline\b/i.test(section), "the routed section fits a parent that never implements");
	// The parent reads the whole file, so the whole module must state its rules in words true for both modes.
	assert.doesNotMatch(module, /\binline\b|small path|small edits|never delegates|Writer (?:rule|trigger)/i, "the module carries an organic routing word");
	for (const sentence of [
		"The change's own focused test and suite run in the session that made the change.",
		"Parent-written code over several deliveries of one feature: one verify at the feature's end.",
		"3. **Seam check**: after parallel units finish, one full-suite command run by the parent (the parent spot check) catches seams between units.",
	]) assert.ok(module.includes(sentence), `module keeps: ${sentence}`);
});
