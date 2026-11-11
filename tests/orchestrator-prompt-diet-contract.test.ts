import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import gentleAgents from "../extensions/gentle-agents.ts";
import { __testing, createGentleAiExtension } from "../extensions/gentle-ai.ts";

// ---------------------------------------------------------------------------
// cost-speed-painpoints S5 (T4): orchestrator prompt diet.
//
// The always-on primary prompt is paid on every parent turn, and in full
// delegation the parent carries it for most of the session's cost. These
// contracts pin the five changes through the rendered primary prompt for both
// workflow modes and both personas, plus the lazy assets and tool declarations
// they touch, and the lowered byte budgets that keep the diet from regrowing.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..");
const ASSETS = join(REPO_ROOT, "assets");
const MODES = ["organic", "full-delegation"] as const;
const PERSONAS = ["gentleman", "neutral"] as const;
const ACTIVE_TOOLS = ["read", "bash", "edit", "write", "subagent_run"] as const;

let scratch: string;
const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
before(() => {
	scratch = mkdtempSync(join(tmpdir(), "t4-diet-"));
	process.env.GENTLE_PI_CONFIG_HOME = join(scratch, "config");
});
after(() => {
	if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
	else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
	rmSync(scratch, { recursive: true, force: true });
});

function render(persona: (typeof PERSONAS)[number], mode: (typeof MODES)[number]): string {
	return __testing.buildGentlePrompt(persona, join(scratch, "project"), ACTIVE_TOOLS, undefined, undefined, mode).replaceAll(ASSETS, "/a");
}

function read(name: string): string {
	return readFileSync(join(ASSETS, name), "utf8");
}

type Declaration = { name: string; description: string; promptSnippet?: string; promptGuidelines?: string[] };
function registeredTools(): Map<string, Declaration> {
	const tools = new Map<string, Declaration>();
	const pi = {
		on() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
		events: { on() {}, emit() {} },
		registerTool(tool: Declaration) { tools.set(tool.name, tool); },
	};
	gentleAgents(pi as never, { GENTLE_PI_CONFIG_HOME: scratch }, { home: scratch, agentHome: scratch });
	createGentleAiExtension({ nativeReviewCli: null })(pi as never);
	return tools;
}

// --- Change 1: the Language Boundary reaches both modes -------------------

const ARTIFACTS_IN_ENGLISH = "(code, code comments, UI copy, identifiers, commit messages, filenames, PR descriptions, tests, fixtures, delegated outputs, and repository-facing documentation) default to English, regardless of the user's conversation language or active persona. Override only when the user explicitly requests another language for that artifact, or when extending a project whose existing convention is non-English.";
const PUBLIC_COMMENTS = "Public/contextual comments and replies are different from technical artifacts.";

test("S5 change 1: the full delegation primary carries the Language Boundary (technical artifacts default to English)", () => {
	for (const persona of PERSONAS) {
		const prompt = render(persona, "full-delegation");
		assert.match(prompt, /^## Language Boundary$/m, `[${persona}] full delegation lost the Language Boundary heading`);
		assert.ok(prompt.includes(`Generated technical artifacts — whether by the parent or by subagents — ${ARTIFACTS_IN_ENGLISH}`), `[${persona}] full delegation lost the English-artifacts rule`);
		assert.ok(prompt.includes(PUBLIC_COMMENTS), `[${persona}] full delegation lost the public-comment language rule`);
		assert.ok(prompt.includes("Subagent-facing English delegation and quote/UI exceptions: `orchestrator-full-delegation-card.md`."), `[${persona}] the pointer must name the card that carries those exceptions`);
	}
});

test("S5 change 1 (preserve): organic keeps the Language Boundary byte for byte", () => {
	const raw = read("orchestrator.md");
	const section = raw.slice(raw.indexOf("## Language Boundary"), raw.indexOf("\n## ", raw.indexOf("## Language Boundary") + 1));
	assert.ok(section.includes(`Generated technical artifacts — whether by the parent inline or by subagents — ${ARTIFACTS_IN_ENGLISH}`));
	for (const persona of PERSONAS) assert.ok(render(persona, "organic").includes(section.trim()), `[${persona}] organic must render the asset's Language Boundary verbatim`);
});

// --- Change 2: writer-only test-first detail leaves the full delegation parent --

const ORGANIC_TEST_FIRST_OPENING = "- For behavior changes with applicable runnable deterministic tests and a clear expected outcome, use test-first by default";
const FULL_DELEGATION_TEST_FIRST = "- Writers apply test-first (RED, GREEN, PRESERVE with its differential check) from their own contract; forward it in every writer handoff and require their observed RED/GREEN evidence or stated exception. Never invent lifecycle evidence or skip checks.";

test("S5 change 2: the full delegation parent carries one short test-first forwarding rule, not the writer procedure", () => {
	for (const persona of PERSONAS) {
		const prompt = render(persona, "full-delegation");
		assert.ok(prompt.includes(FULL_DELEGATION_TEST_FIRST), `[${persona}] full delegation must forward test-first to writers and require their evidence`);
		assert.ok(!prompt.includes(ORGANIC_TEST_FIRST_OPENING), `[${persona}] full delegation must not carry the writer-applied test-first bullet`);
		assert.ok(!prompt.includes("Write one RED test per requested rule."), `[${persona}] writer procedure leaked into the full delegation parent`);
	}
});

test("S5 change 2 (preserve): organic keeps the full test-first bullet, and the worker still carries the procedure", () => {
	for (const persona of PERSONAS) {
		const bullet = render(persona, "organic").split("\n").find((line) => line.startsWith(ORGANIC_TEST_FIRST_OPENING));
		assert.ok(bullet, `[${persona}] organic lost the test-first bullet`);
		for (const clause of ["Write one RED test per requested rule.", "run one differential check before finishing", "Never invent lifecycle evidence or skip checks.", "Follow orchestrator-delegation.md for ODD forwarding and evidence."]) {
			assert.ok(bullet.includes(clause), `[${persona}] organic test-first bullet lost: ${clause}`);
		}
	}
	const worker = read("agents/gentle-ai-worker.md");
	for (const clause of ["RED", "GREEN", "PRESERVE", "run one differential check before finishing", "no meaningful RED"]) assert.ok(worker.includes(clause), `worker lost ${clause}`);
});

// --- Change 3: the Engram mirror is written at task transitions ------------

const MIRROR_CADENCE = "Refresh the Engram mirror once per task transition (a task starts, finishes, is blocked, reopened, or dropped) or material plan change, and at close; `## Log` entries and evidence added between those points go to the file only and reach the mirror at the next one.";

test("S5 change 3: the mirror cadence is per task transition, with log entries reaching it at the next transition", () => {
	const memory = read("orchestrator-memory.md");
	assert.ok(memory.includes(MIRROR_CADENCE), "orchestrator-memory.md must state the per-transition mirror cadence");
	// The file stays the source and the PR #3083 wording stays: no custom reconciliation gates.
	assert.ok(memory.includes("The file is the source: a mirror that differs from the file just written is refreshed from the file, never a blocker."));
	assert.ok(memory.includes("never author comparison or reconciliation scripts or gates for them"));
	assert.ok(memory.includes("On resume, use `mem_context`"), "resume guarantees must stay");
	assert.doesNotMatch(read("orchestrator-tracking.md"), /mirror[^.]*(?:after every (?:edit|log entry|write)|on every (?:edit|log entry|write))/i, "tracking must not contradict the cadence");
});

// --- Change 4: admission requirements are stated where the launch is composed --

const ADMISSION = "Admission rejects writers without repository-relative `## Allowed edit surfaces`; below the context backstop, organic writers without `Spec: odd/tasks/<existing>.md, T<n>` (2+ disjoint writers alone in one message pass) and `gentle-ai-verify` without that or `Risk: item N`.";

test("S5 change 4: the subagent_run description names what admission rejects", () => {
	const run = registeredTools().get("subagent_run");
	assert.ok(run, "subagent_run must be registered");
	assert.ok(run.description.startsWith("Delegate a task to a named subagent."), "the original description stays first");
	assert.ok(run.description.includes(ADMISSION), "the admission sentence must be stated exactly");
});

// --- Change 5: literal duplicates leave the always-on prompt ----------------

test("S5 change 5: the persistent-memory rule is stated once (Identity), not again in Harness principles", () => {
	for (const mode of MODES) for (const persona of PERSONAS) {
		const prompt = render(persona, mode);
		assert.equal(prompt.split("never invent persistent memory").length - 1, 1, `[${mode}/${persona}] Identity memory rule must stay once`);
		assert.ok(!prompt.includes("Never claim persistent memory is available because of this package."), `[${mode}/${persona}] harness duplicate must go`);
	}
});

test("S5 change 5: the neutral persona states its Spanish register once (persona bullets), with no second Language line", () => {
	for (const mode of MODES) {
		const prompt = render("neutral", mode);
		assert.ok(!prompt.includes("Language: neutral/professional Spanish when the user writes Spanish."), `[${mode}] neutral duplicate Language line must go`);
		assert.ok(prompt.includes("- When the user writes Spanish, use neutral/professional Spanish. Do NOT use voseo or any regional conjugations"), `[${mode}] neutral register rule must stay`);
		assert.ok(prompt.includes("- Do not use slang or regional expressions."), `[${mode}] regional-expressions rule must stay`);
		// P14 (PD-57): the gentleman persona also states its register once, in its persona bullet.
		const gentleman = render("gentleman", mode);
		assert.ok(!gentleman.includes("Language: natural Rioplatense Spanish with voseo when the user writes Spanish."), `[${mode}] gentleman duplicate Language line must go`);
		assert.ok(gentleman.includes("- When the user writes Spanish, answer in natural Rioplatense Spanish with voseo."), `[${mode}] gentleman register rule must stay`);
	}
});

test("S5 change 5: gentle_odd_phase does not restate the Phase reporting cadence, but keeps its own rules", () => {
	const phase = registeredTools().get("gentle_odd_phase");
	assert.ok(phase, "gentle_odd_phase must be registered");
	const prose = [phase.promptSnippet ?? "", ...(phase.promptGuidelines ?? [])].join("\n");
	assert.ok(!/never per tool call|never poll or report per tool call/.test(prose), "the cadence lives once, in the always-on Phase reporting line");
	assert.ok(prose.includes("Pass phase exactly as its schema enum"), "schema rule must stay");
	assert.ok(prose.includes("Never call this from a subagent or background/child task"), "child rule must stay: children do not receive Phase reporting");
	for (const mode of MODES) {
		assert.ok(render("gentleman", mode).includes("call `gentle_odd_phase` only when the primary session's ODD phase actually changes, never per tool call or on a fixed cadence, and never from a subagent"), `[${mode}] Phase reporting keeps the cadence`);
	}
});

// --- Net bytes: both modes shrink, and the pins follow ----------------------

// Measured at /a (normalized assets root), ACTIVE_TOOLS, default RDD line. Base c09189269 rendered
// organic 25,482/25,778 B and full delegation 23,309/23,605 B (gentleman/neutral); the diet pins the new sizes.
// cost-speed-painpoints S15 P5a: the verifier-setup paragraph moved to orchestrator-verification.md and the
// always-on verdicts landed; measured organic 24,256/24,428 B and full delegation 22,161/22,333 B (default RDD line).
// Verifier B1: the full-delegation Verify mechanism routes a verifier setup failure to that module (+92 B).
// cost-speed P14: the duplicate gentleman Language line (-80 B, PD-57) and the core's evidence-budget number aligned
// to the runtime (-12 B in both modes, PD-81); measured organic 24,164/24,416 B and full delegation 22,131/22,383 B.
const PRIMARY_PROMPT_BUDGETS: Record<(typeof MODES)[number], Record<(typeof PERSONAS)[number], number>> = {
	organic: { gentleman: 24_164, neutral: 24_416 },
	// cost-speed P6 (X9): launch form, continue-one-worker rule and the tracking pointer, paid by the motivation
	// sentence and a duplicate of step 6's verbatim-request rule (22,253/22,425 -> 22,223/22,395 B).
	// cost-speed P6b: the launch sentence names the same assistant message, the `codemode` route and the sequential
	// tools (+126 B), paid by tightening five sentences of the same asset (22,131/22,383 -> 22,128/22,380 B).
	"full-delegation": { gentleman: 22_128, neutral: 22_380 },
};

test("S5: the rendered primary prompt fits the lowered per-mode budgets", (t) => {
	for (const mode of MODES) for (const persona of PERSONAS) {
		const bytes = Buffer.byteLength(render(persona, mode), "utf8");
		t.diagnostic(`${mode}/${persona}: ${bytes} B (budget ${PRIMARY_PROMPT_BUDGETS[mode][persona]} B)`);
		assert.ok(bytes <= PRIMARY_PROMPT_BUDGETS[mode][persona], `${mode}/${persona} primary prompt is ${bytes} B, over ${PRIMARY_PROMPT_BUDGETS[mode][persona]} B`);
	}
});

// --- Verifier follow-up A1: the differential-check pointer is true in both modes --

test("S5 A1: the card and its source forward the differential check without naming the harness policy", () => {
	for (const name of ["orchestrator-delegation.md", "orchestrator-full-delegation-card.md"]) {
		const text = read(name);
		assert.ok(!text.includes("the harness test-first policy's differential check"), `${name} must not point at a harness bullet full delegation no longer carries`);
		const line = text.split("\n").find((candidate) => candidate.startsWith("**Differential check (PRESERVE):**"));
		assert.ok(line?.includes("forward the test-first differential check to writers"), `${name} must still forward the differential check to writers`);
	}
});

// --- Change 4 behavior: the admission sentence matches the admission code ---

test("S5 change 4: admission behaves as the subagent_run sentence states", async () => {
	const { rejectUndocumentedWriterLaunch } = await import("../lib/bounded-writer-admission.ts");
	const { rejectUnriskedVerifierLaunch } = await import("../lib/verifier-admission.ts");
	const root = mkdtempSync(join(scratch, "admission-"));
	const belowBackstop = { tokens: 1_000, contextWindow: 1_000_000 };
	const env = {};
	const writer = { agent: "gentle-ai-worker", task: "Change one file.\n\n## Allowed edit surfaces\nsrc/a.ts" };
	assert.ok(rejectUndocumentedWriterLaunch(writer, { root, contextUsage: belowBackstop, env, orchestratorMode: "organic" })?.block, "organic writer without Spec: is rejected below the backstop");
	assert.equal(rejectUndocumentedWriterLaunch(writer, { root, contextUsage: belowBackstop, env, orchestratorMode: "full-delegation" }), undefined, "full delegation never rejects a writer for a missing Spec:");
	const sibling = { agent: "gentle-ai-worker", task: "Change another file.\n\n## Allowed edit surfaces\nsrc/b.ts" };
	const batch = [writer, sibling].map(input => ({ name: "subagent_run", arguments: input }));
	assert.equal(rejectUndocumentedWriterLaunch(writer, { root, contextUsage: belowBackstop, env, orchestratorMode: "organic", sameMessageCalls: batch }), undefined, "2+ disjoint writers alone in one message pass");
	assert.ok(rejectUndocumentedWriterLaunch(writer, { root, contextUsage: belowBackstop, env, orchestratorMode: "organic", sameMessageCalls: [...batch, { name: "read", arguments: { path: "a" } }] })?.block, "not with another call beside them");
	const verifier = { agent: "gentle-ai-verify", task: "Verify the change." };
	assert.ok(rejectUnriskedVerifierLaunch(verifier, { root, contextUsage: belowBackstop, env })?.block, "verifier without Risk: item N or Spec: is rejected (admission takes no mode, so full delegation too)");
	assert.equal(rejectUnriskedVerifierLaunch({ ...verifier, task: "Verify the change.\nRisk: item 3 (shared parser)" }, { root, contextUsage: belowBackstop, env }), undefined, "a declared Risk: item 3 is admitted");
});
