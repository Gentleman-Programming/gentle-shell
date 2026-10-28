import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// gentle-shell#1731 T16 (S5; L33-L34): in the after3 bench (B x4/x5) the first
// verify launch ran no probes because the handoff said only "read-only" and
// named no probe commands or isolated state, so every probe was reported
// unverified and the parent continued the task (~2 min per cell). Read-only now
// means no repository or git-state edits, and probes in a fresh scratch copy run
// on the first launch.
// T17 (S3; L33-L34): B x4 delegated a 1.2 min exploration and then the parent
// re-read the same 10 files; exploration is delegated only for a map the parent
// needs to decide or route.
// These are instruction-delivery contracts, not proof of model adherence.

const read = (relative: string): string => readFileSync(join(import.meta.dirname, "..", relative), "utf8");
const verify = read("assets/agents/gentle-ai-verify.md");
const verification = read("assets/orchestrator-verification.md");

function containsAll(text: string, clauses: readonly string[], label: string): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `${label} is missing: ${clause}`);
}

test("T16: read-only means no repository or git-state edits", () => {
	containsAll(verify, [
		"read-only technical verifier for generic ODD work",
		"Read-only means no edits to the repository or its git state",
	], "verify agent");
});

test("T16: verify probes on its first launch inside a fresh mktemp scratch copy without waiting for authorization", () => {
	containsAll(verify, [
		"Probe on your first launch; never wait for further authorization",
		"fresh `mktemp -d` scratch copy of the workspace",
		"the project's own test, CLI, and typecheck commands",
		"No network, no installs, no writes outside the scratch directory",
		"report that probe as unverified with its exact command instead of running it",
	], "first-launch probe rule");
	assert.ok(
		!verify.includes("Run every probe only through command forms the parent authorized and only on isolated state the parent named"),
		"the old rule makes every probe unverified when the handoff names no commands",
	);
});

test("T16/W1: the scratch copy method cannot write outside the scratch directory", () => {
	containsAll(verify, [
		"copy the workspace files without `.git`",
		"never `git worktree`, `git stash`, or a symlink into the workspace",
		"set `HOME` and `TMPDIR` inside the scratch directory",
	], "scratch copy method");
});

// T21 (L44): in after4, verify reported a behavior already present at the
// baseline (B x5, unchecked import amounts the request kept "as they do today")
// and a value far outside the realistic domain (B x4, sums near 9e15) as
// blockers; each forced a correction round. Blockers need provenance and
// realistic inputs; the rest are reported as advisories.
test("T21: verify grades severity by provenance and realistic inputs", () => {
	containsAll(verify, [
		"## Severity",
		"A blocker is a defect the change caused or a spec item the change leaves unmet",
		"Before calling a finding a blocker, reproduce it at the baseline",
		"already present at the baseline and not asked to change is a pre-existing advisory",
		"only with inputs outside the realistic domain",
		"is an advisory",
		"Any file, flag, or value a user can feed through the program's own commands is realistic input, hand-edited files included",
		"a rule the request sets for one entry path holds for every path that creates the same data",
		"Silently ignoring an option or value the user passed explicitly, with a success exit, is always a blocker",
		"An unrequested change to the output, error text, or line numbering of a command that existed at the baseline is change-caused and a blocker, even when it looks like an improvement",
	], "verify severity rule");
});

// T22 (L45): R-xh x4 ran about six verify/fix/recheck rounds on one delivery
// (each recheck found something new) and hit the 60 min timeout; the only rule
// was "resolve every unmet item before closing". Corrections are bounded.
test("T22: verify blockers get one correction batch and one scoped recheck", () => {
	containsAll(verification, [
		"5. **One correction**",
		"one correction batch that fixes every reported blocker",
		"one re-verify limited to those blockers",
		"never a new full sweep",
		"Blockers still open after that stop as one **Needs your decision**",
		"Advisories never start a correction",
		"A second correction runs automatically only when the recheck shows the same blocker still failing",
		"a new finding never earns one",
	], "verification correction bound");
	containsAll(verify, [
		"Keep the scratch path in your commands; never write it, or anything else, to a file outside the scratch",
		"NO_UPDATE_NOTIFIER=1",
		"Create the scratch directory with `mktemp -d` under the system temp directory, never inside the workspace",
		"`NODE_COMPILE_CACHE`",
		"leave no new file in the workspace",
	], "verify scratch hygiene");
});

test("T16: verify keeps its repository and tool boundaries", () => {
	containsAll(verify, [
		"Do not edit, write, or fix findings.",
		"install dependencies, or mutate repository state",
		"Treat every unexpected mutation as a blocker",
	], "verify boundaries");
	const tools = verify.split("---")[1] ?? "";
	assert.ok(!/\n {2}- (edit|write)\n/.test(tools), "verify must not gain edit or write tools");
});

test("T16: the verify handoff names probe command forms and the scratch location, never just read-only", () => {
	const item = verification.split("\n").find((line) => line.startsWith("4. **Verify handoff**"));
	assert.ok(item, "verify handoff item is missing");
	containsAll(item, [
		"the probe command forms (tests, CLI, typecheck)",
		"probes on isolated state",
		"fresh `mktemp -d` scratch copy",
		"never just \"read-only\"",
	], "verify handoff");
});

// T17b (L42): after4 B x5 read two files, then the core Evidence-budget rule
// fired and delegated a 1.5 min exploration on a small task the parent then
// implemented inline. The trigger itself must exclude reading for an inline write.
test("T17b: the core Evidence-budget rule never fires to prepare an inline write", () => {
	const core = read("assets/orchestrator.md");
	const rule = core.split("\n").find((line) => line.includes("**Evidence-budget rule**"));
	assert.ok(rule, "Evidence-budget rule is missing");
	assert.ok(rule.includes("never for reading before an inline write"), "Evidence-budget rule must exclude reading for an inline write");
});

test("T17: the always-on Explore step delegates exploration only for a map the parent needs", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona);
		const step = prompt.split("\n").find((line) => line.startsWith("2. **Explore.**"));
		assert.ok(step, "ODD step 2 Explore is missing");
		containsAll(step, [
			"Do not delegate exploration of files you will read anyway to work inline",
			"explore only for a map you need to decide or route",
		], "ODD Explore step");
	}
});
