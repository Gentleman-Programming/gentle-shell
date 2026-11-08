import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { blockChildDestructiveCommand } from "../extensions/child-safety.ts";
import { __testing } from "../extensions/gentle-ai.ts";
import { recognizeDestructiveCommands } from "../lib/destructive-command-guard.ts";

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
let scratch: string;
let previousConfigHome: string | undefined;
before(() => {
	scratch = mkdtempSync(join(tmpdir(), "gentle-verify-first-"));
	previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = join(scratch, "config");
});
after(() => {
	if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
	else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function containsAll(text: string, clauses: readonly string[], label: string): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `${label} is missing: ${clause}`);
}

// Issue #1494: these pin prompt policy, not a runtime-enforced limit or model compliance.
test("S1: verifier makes one isolated preparation attempt before checks", () => {
	containsAll(verify, [
		"Make one isolated preparation attempt",
		"If preparation succeeds, run the authorized checks and independent spec-derived probes",
	], "preparation bound");
});

test("S2: preparation failure reports a concrete blocker and exact unrun checks", () => {
	containsAll(verify, [
		"At the first inability to prepare a required copy, environment, dependency, or helper, stop setup",
		"report one concrete setup blocker and the exact checks left unrun as unverified, not passed",
		"list every scratch directory you created by exact path",
	], "setup failure");
});

test("S3: setup failures do not trigger repair loops or automatic relaunch", () => {
	containsAll(verify, ["Do not retry setup or enter repair-helper loops"], "verifier setup");
	containsAll(verification, [
		"Do not automatically relaunch the verifier for the same missing prerequisite",
		"Distinguish setup or infrastructure failure from genuine code findings",
		"stop with one **Needs your decision** result identifying the missing prerequisite and exact unrun checks",
		"Do not keep repairing helpers",
		"Auxiliary tooling defects remain subject to the existing correction bound",
	], "parent setup");
});

test("S2-S3: setup recovery references the always-on bounded policy", () => {
	containsAll(verification, [
		"Follow **Authorized work continuity** for setup and worker recovery; scratch: `gentle-ai-verify`.",
		"Do not automatically relaunch the verifier for the same missing prerequisite",
	], "parent setup recovery");
});

test("S3: scratch preparation establishes capacity and a complete payload before copying", () => {
	containsAll(verify, [
		"Before isolated setup, establish the required payload, available dependencies, and scratch capacity, including space and inodes when relevant.",
		"A smaller copy is permitted only when it includes all source, test/build files, baseline material, and dependencies needed for every authorized probe.",
		"If a prerequisite cannot be established, report it as missing instead of blindly copying or omitting required inputs",
		"If setup fails before probes, preserve the failed attempt and report zero tests run",
		"never `git worktree`, `git stash`, or a symlink into the workspace",
		"No network, no installs, no writes outside the scratch directory",
		"under the system temp directory, never inside the workspace",
	], "scratch isolation remains required");
});

test("S5: documentation identifies the instruction as policy rather than runtime enforcement", () => {
	const docs = read("docs/delegated-verification.md");
	containsAll(docs, [
		"one isolated preparation attempt",
		"prompt policy, not a runtime-enforced limit",
		"unverified, not passed",
	], "delegated verification documentation");
});

test("S4: successful setup retains independent probes, isolation, consent and finding correction", () => {
	containsAll(verify, [
		"independent probes required by the risk tier",
		"never `git worktree`, `git stash`, or a symlink into the workspace",
		"No network, no installs, no writes outside the scratch directory",
		"one correction batch and one recheck limited to the reported blockers",
	], "verification safeguards");
	containsAll(verification, [
		"one separate `gentle-ai-verify` run",
		"one correction batch that fixes every reported blocker",
	], "parent safeguards");
	assert.ok(read("docs/delegated-verification.md").includes("human consent for native review"));
});

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

// gentle-shell#2818: the prompt asked for a copy without `.git` but named only
// `cp -a --reflink=auto`, which cannot exclude anything. Verifiers then ran
// `rm -rf "$s/work/.git"` (blocked by child safety) or `cp --exclude` (no such
// option), so no probe ran. The prompt names one exact guard-compatible form.
const SCRATCH_COPY = /`((?:set -o pipefail && )?mkdir -p "\$s\/work" && tar --exclude=\.\/\.git [^`]+)`/;

test("#2818: the scratch copy names one exact command the child guard allows", () => {
	const command = verify.match(SCRATCH_COPY)?.[1];
	assert.ok(command, "verify must name the exact tar scratch copy command");
	assert.deepEqual(recognizeDestructiveCommands(command), []);
	assert.equal(blockChildDestructiveCommand(command), undefined);
	assert.ok(!verify.includes("for example `cp -a --reflink=auto`"), "the cp example cannot exclude `.git`");
	containsAll(verify, [
		"never copy `.git` and delete it afterwards",
		"`cp` has no `--exclude` option",
	], "scratch copy method");
});

test("#2818: the named scratch copy omits top-level .git and keeps dotfiles, dependencies and symlinks", (t) => {
	const command = verify.match(SCRATCH_COPY)?.[1];
	assert.ok(command);
	const workspace = join(scratch, "workspace");
	mkdirSync(join(workspace, ".git", "objects"), { recursive: true });
	writeFileSync(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(workspace, ".env.example"), "KEY=\n");
	mkdirSync(join(workspace, "node_modules", "dep"), { recursive: true });
	writeFileSync(join(workspace, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
	mkdirSync(join(workspace, "app"));
	mkdirSync(join(workspace, "shared"));
	writeFileSync(join(workspace, "shared", "value.cjs"), "module.exports = 2;\n");
	writeFileSync(join(workspace, "app", "intended-untracked.cjs"), 'if (require("dep") + require("../shared/value.cjs") !== 3) process.exit(1);\n');
	mkdirSync(join(workspace, "node_modules", ".bin"));
	symlinkSync("../dep/index.js", join(workspace, "node_modules", ".bin", "dep"));
	const s = mkdtempSync(join(scratch, "probe-"));
	const started = performance.now();
	const result = spawnSync("bash", ["-c", command], { cwd: workspace, env: { ...process.env, s }, encoding: "utf8" });
	const elapsedMs = performance.now() - started;
	assert.equal(result.status, 0, result.stderr);
	const work = join(s, "work");
	assert.equal(existsSync(join(work, ".git")), false);
	assert.equal(readFileSync(join(work, ".env.example"), "utf8"), "KEY=\n");
	assert.equal(readFileSync(join(work, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n");
	assert.equal(readlinkSync(join(work, "node_modules", ".bin", "dep")), "../dep/index.js");
	const probe = spawnSync(process.execPath, [join(work, "app", "intended-untracked.cjs")], { cwd: work, encoding: "utf8" });
	assert.equal(probe.status, 0, probe.stderr);
	assert.equal(existsSync(join(workspace, ".git", "HEAD")), true);
	const payloadBytes = [".env.example", "node_modules/dep/index.js", "shared/value.cjs", "app/intended-untracked.cjs"]
		.reduce((bytes, path) => bytes + readFileSync(join(workspace, path)).byteLength, 0);
	t.diagnostic(`fixture copy: ${elapsedMs.toFixed(1)} ms, ${payloadBytes} regular-file bytes plus one symlink; no production throughput claim`);
});

// #3009: a producer read failure can still leave a valid partial tar stream.
// Without pipefail, a successful extractor hides that failure and admits probes
// against missing candidate inputs. Reproduced on Windows with a locked file;
// a missing required input gives the same deterministic producer failure here.
test("#3009: a failed archive producer cannot run probes against its partial payload", () => {
	const command = verify.match(SCRATCH_COPY)?.[1];
	assert.ok(command);
	const workspace = mkdtempSync(join(scratch, "producer-source-"));
	writeFileSync(join(workspace, "intended-untracked.txt"), "candidate\n");
	const s = mkdtempSync(join(scratch, "producer-copy-"));
	const producerFailure = 'tar() { if [[ "$*" == *"-cf -"* ]]; then command tar "$@" missing-required-input; else command tar "$@"; fi; }';
	const result = spawnSync("bash", ["-c", `${producerFailure}\n${command} && printf probe-ran > "$s/probe-ran"`], {
		cwd: workspace, env: { ...process.env, s }, encoding: "utf8",
	});
	assert.notEqual(result.status, 0, "a successful extractor must not mask its failed producer");
	assert.match(result.stderr, /missing-required-input/);
	assert.equal(readFileSync(join(s, "work", "intended-untracked.txt"), "utf8"), "candidate\n", "the failure produced a readable but incomplete copy");
	assert.equal(existsSync(join(s, "probe-ran")), false, "no verification runs after setup failure");
});

test("#3009: a failed extractor cannot run probes", () => {
	const command = verify.match(SCRATCH_COPY)?.[1];
	assert.ok(command);
	const workspace = mkdtempSync(join(scratch, "extractor-source-"));
	writeFileSync(join(workspace, "candidate.txt"), "candidate\n");
	const s = mkdtempSync(join(scratch, "extractor-copy-"));
	const extractorFailure = 'tar() { if [[ "$*" == *"-xf -"* ]]; then cat > /dev/null; return 2; else command tar "$@"; fi; }';
	const result = spawnSync("bash", ["-c", `${extractorFailure}\n${command} && printf probe-ran > "$s/probe-ran"`], {
		cwd: workspace, env: { ...process.env, s }, encoding: "utf8",
	});
	assert.notEqual(result.status, 0);
	assert.equal(existsSync(join(s, "probe-ran")), false);
});

test("#3009: the prescribed tar copy skips a live Unix socket and keeps candidate input", { skip: process.platform === "win32" }, async (t) => {
	const command = verify.match(SCRATCH_COPY)?.[1];
	assert.ok(command);
	const workspace = mkdtempSync(join(scratch, "socket-source-"));
	mkdirSync(join(workspace, ".codegraph"));
	writeFileSync(join(workspace, "intended-untracked.txt"), "candidate\n");
	const socket = join(workspace, ".codegraph", "daemon.sock");
	const server = createServer();
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
	t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
	const s = mkdtempSync(join(scratch, "socket-copy-"));
	const result = spawnSync("bash", ["-c", command], { cwd: workspace, env: { ...process.env, s }, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(join(s, "work", ".codegraph", "daemon.sock")), false);
	assert.equal(readFileSync(join(s, "work", "intended-untracked.txt"), "utf8"), "candidate\n");
	assert.equal(existsSync(socket), true, "the live source socket is untouched");
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

// T17b (L42): preparation for an understood inline write stays inline, but
// discovery cannot evade the evidence budget merely because a write is planned.
test("T17b: inline-write preparation is distinct from discovery", () => {
	const core = read("assets/orchestrator.md");
	const rule = core.split("\n").find((line) => line.includes("**Evidence-budget rule**"));
	assert.ok(rule, "Evidence-budget rule is missing");
	assert.match(rule, /Exempt only preparation for an understood inline write, not discovery/);
	assert.match(rule, /cumulative discovery each batch, never reset/);
	assert.match(core, /No explore, worker, or verifier unless a trigger fires/);
});

test("T17: the always-on Explore step delegates exploration only for a map the parent needs", () => {
	for (const persona of ["gentleman", "neutral"] as const) {
		const prompt = __testing.buildGentlePrompt(persona, scratch, ["read"]);
		const step = prompt.split("\n").find((line) => line.startsWith("2. **Explore.**"));
		assert.ok(step, "ODD step 2 Explore is missing");
		containsAll(step, [
			"Do not delegate exploration of files you will read anyway to work inline",
			"explore only for a map you need to decide or route",
		], "ODD Explore step");
	}
});
