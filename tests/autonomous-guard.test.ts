import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

const { classifyGuardedCommand, evaluateGuardedCommand, guardedCommandPreview, guardedCommandTitle } = __testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "gentle-pi-autonomous-"));
}

function writeConfig(dir: string, relPath: string, content: unknown): void {
	const full = join(dir, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, JSON.stringify(content, null, 2));
}

// ---------------------------------------------------------------------------
// classifyGuardedCommand — base contract
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: git push plain → confirm by default (no autonomous mode)", () => {
	const result = classifyGuardedCommand("git push origin main", {
		autonomousMode: false,
		guardedCommands: {},
	});
	assert.equal(result, "confirm");
});

test("classifyGuardedCommand: git rebase → confirm by default (no autonomous mode)", () => {
	const result = classifyGuardedCommand("git rebase main", {
		autonomousMode: false,
		guardedCommands: {},
	});
	assert.equal(result, "confirm");
});

test("classifyGuardedCommand: npm publish → confirm by default (no autonomous mode)", () => {
	const result = classifyGuardedCommand("npm publish", {
		autonomousMode: false,
		guardedCommands: {},
	});
	assert.equal(result, "confirm");
});

test("classifyGuardedCommand: unknown command → not-guarded", () => {
	const result = classifyGuardedCommand("echo hello", {
		autonomousMode: false,
		guardedCommands: {},
	});
	assert.equal(result, "not-guarded");
});

// ---------------------------------------------------------------------------
// Hard-deny always blocks regardless of autonomous mode or config
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: git push --force always blocked even with gitPush=allow", () => {
	const result = classifyGuardedCommand("git push --force origin main", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: git push --force-with-lease always blocked", () => {
	const result = classifyGuardedCommand("git push --force-with-lease origin main", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: git push -f always blocked even in autonomous mode", () => {
	const result = classifyGuardedCommand("git push -f origin main", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: git reset --hard always blocked", () => {
	const result = classifyGuardedCommand("git reset --hard HEAD~1", {
		autonomousMode: true,
		guardedCommands: {},
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: rm -rf / always blocked", () => {
	const result = classifyGuardedCommand("rm -rf /", {
		autonomousMode: true,
		guardedCommands: {},
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: rm -rf ~ always blocked", () => {
	const result = classifyGuardedCommand("rm -rf ~", {
		autonomousMode: true,
		guardedCommands: {},
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: chmod -R 777 always blocked", () => {
	const result = classifyGuardedCommand("chmod -R 777 /etc", {
		autonomousMode: true,
		guardedCommands: {},
	});
	assert.equal(result, "block");
});

// ---------------------------------------------------------------------------
// Autonomous mode + allow action
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: git push plain allowed when autonomousMode=true and gitPush=allow", () => {
	const result = classifyGuardedCommand("git push origin feature/test", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "allow");
});

test("classifyGuardedCommand: configured push allow is remote-agnostic and unchanged", () => {
	const config = { autonomousMode: true, guardedCommands: { gitPush: "allow" as const } };
	for (const command of [
		"git push origin feature/test",
		"git push upstream feature/test",
		"git push fork feature/test",
		"git push",
		"git push feature/test && git status",
		"echo done || git push origin feature/test",
	]) {
		assert.equal(classifyGuardedCommand(command, config), "allow", command);
	}
	assert.equal(
		classifyGuardedCommand("git push origin feature/test", { autonomousMode: true, guardedCommands: { gitPush: "block" } }),
		"block",
	);
	for (const command of [
		"git push -f origin feature/test",
		"git push --force origin main",
		"git push --force-with-lease origin feature/test",
	]) {
		assert.equal(classifyGuardedCommand(command, config), "block", command);
	}
});

// ---------------------------------------------------------------------------
// Guarded command preview — presentation-only centering
// ---------------------------------------------------------------------------

test("guardedCommandPreview: long late matched action stays visible in preview", () => {
	const prefix = "noise ".repeat(80);
	const command = `${prefix}git push origin feature/test`;
	// Contract: the caller owns the trigger index. confirmCommand hands over
	// evaluation.triggerIndex, so the preview always centers on the matched
	// action supplied by the evaluator.
	const triggerIndex = command.indexOf("git push");
	const preview = guardedCommandPreview(command, triggerIndex);
	assert.match(preview, /git push origin feature\/test/);
	assert.ok(preview.startsWith("…"), "preview elides leading context near a late match");
});

test("guardedCommandPreview: late non-push action visible, elided, and width-bounded", () => {
	const prefix = "noise ".repeat(80);
	const command = `${prefix}npm publish --tag beta`;
	const triggerIndex = command.indexOf("npm publish");
	const preview = guardedCommandPreview(command, triggerIndex);
	assert.match(preview, /npm publish --tag beta/);
	assert.ok(preview.startsWith("…"), "preview elides leading context near a late match");
	// Bounded visible width: 1 leading ellipsis + up to 179 content chars (budget 180).
	assert.ok(preview.length <= 180, `preview exceeds bounded width: ${preview.length}`);
});

// ---------------------------------------------------------------------------
// Guarded command title — presentation-only, action-specific
// ---------------------------------------------------------------------------

test("guardedCommandTitle: exact action-specific titles per guarded key", () => {
	assert.equal(guardedCommandTitle("gitPush"), "Allow guarded git push?");
	assert.equal(guardedCommandTitle("gitRebase"), "Allow guarded git rebase?");
	assert.equal(
		guardedCommandTitle("gitBranchDeleteForce"),
		"Allow guarded forced git branch deletion?",
	);
	assert.equal(guardedCommandTitle("npmPublish"), "Allow guarded npm publish?");
	assert.equal(guardedCommandTitle("piRemove"), "Allow guarded pi remove?");
});

test("guardedCommandTitle: unkeyed guarded command falls back to generic title", () => {
	assert.equal(guardedCommandTitle(undefined), "Allow guarded command?");
});

test("evaluateGuardedCommand: collects guarded matches in command order and applies full-command precedence", () => {
	const command = "npm publish && git push origin main && git rebase main";
	const evaluation = evaluateGuardedCommand(command, {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow", gitRebase: "confirm", npmPublish: "block" },
	});
	assert.deepEqual(evaluation.matches.map((match) => [match.key, match.action]), [
		["npmPublish", "block"],
		["gitPush", "allow"],
		["gitRebase", "confirm"],
	]);
	assert.deepEqual(evaluation.matches.map((match) => command.slice(match.triggerIndex).split(/\s/, 1)[0]), ["publish", "push", "rebase"]);
	assert.equal(evaluation.action, "block");

	assert.equal(evaluateGuardedCommand("git rebase main && git push --force origin main", {
		autonomousMode: true,
		guardedCommands: { gitRebase: "allow", gitPush: "allow" },
	}).action, "block", "a later hard deny overrides an earlier allowed action");
});

test("evaluateGuardedCommand: git -C stores the push token offset for bounded previews", () => {
	const command = `git -C /${"very-long-path/".repeat(30)} push origin main`;
	const evaluation = evaluateGuardedCommand(command, { autonomousMode: false, guardedCommands: {} });
	assert.equal(command.slice(evaluation.triggerIndex, evaluation.triggerIndex + 4), "push");
	assert.match(guardedCommandPreview(command, evaluation.triggerIndex), /push origin main/);
});

test("evaluateGuardedCommand: git -C path containing push still offsets the push action", () => {
	const command = `git -C /${"push-path/".repeat(30)} push origin main`;
	const evaluation = evaluateGuardedCommand(command, { autonomousMode: false, guardedCommands: {} });
	assert.equal(evaluation.triggerIndex, command.lastIndexOf("push"));
	assert.match(guardedCommandPreview(command, evaluation.triggerIndex), /push origin main/);
});

test("evaluateGuardedCommand: repeated forced branch deletions remain separate matches", () => {
	const command = "git branch --delete --force old && git branch --delete --force older";
	const evaluation = evaluateGuardedCommand(command, { autonomousMode: false, guardedCommands: {} });
	assert.deepEqual(evaluation.matches.map((match) => match.key), ["gitBranchDeleteForce", "gitBranchDeleteForce"]);
	assert.equal(
		guardedCommandTitle(evaluation.key, evaluation.matches),
		"Allow guarded actions: forced git branch deletion; forced git branch deletion?",
	);
});

test("classifyGuardedCommand: git push plain still confirm when autonomousMode=false even with gitPush=allow in config", () => {
	const result = classifyGuardedCommand("git push origin feature/test", {
		autonomousMode: false,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "confirm");
});

// ---------------------------------------------------------------------------
// Autonomous mode + confirm action (stays gated)
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: git rebase stays confirm when autonomousMode=true and gitRebase=confirm", () => {
	const result = classifyGuardedCommand("git rebase main", {
		autonomousMode: true,
		guardedCommands: { gitRebase: "confirm" },
	});
	assert.equal(result, "confirm");
});

test("classifyGuardedCommand: git branch -D stays confirm in autonomous mode (gitBranchDeleteForce=confirm)", () => {
	const result = classifyGuardedCommand("git branch -D old-feature", {
		autonomousMode: true,
		guardedCommands: { gitBranchDeleteForce: "confirm" },
	});
	assert.equal(result, "confirm");
});

test("classifyGuardedCommand: git branch -df stays confirm in autonomous mode", () => {
	const result = classifyGuardedCommand("git branch -df old-feature", {
		autonomousMode: true,
		guardedCommands: { gitBranchDeleteForce: "confirm" },
	});
	assert.equal(result, "confirm");
});

test("classifyGuardedCommand: git branch --delete --force stays confirm in autonomous mode", () => {
	const result = classifyGuardedCommand("git branch --delete --force old-feature", {
		autonomousMode: true,
		guardedCommands: { gitBranchDeleteForce: "confirm" },
	});
	assert.equal(result, "confirm");
});

// ---------------------------------------------------------------------------
// Autonomous mode + block action
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: npm publish blocked when autonomousMode=true and npmPublish=block", () => {
	const result = classifyGuardedCommand("npm publish", {
		autonomousMode: true,
		guardedCommands: { npmPublish: "block" },
	});
	assert.equal(result, "block");
});

// ---------------------------------------------------------------------------
// loadRuntimeGuardrailsConfig — file loading
// ---------------------------------------------------------------------------

test("loadRuntimeGuardrailsConfig: returns off config when no file exists", () => {
	const dir = makeTmpDir();
	try {
		const config = __testing.loadRuntimeGuardrailsConfig(dir, {
			gentlePiConfigHome: join(dir, "global-config"),
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadRuntimeGuardrailsConfig: env var GENTLE_PI_AUTONOMOUS_MODE=1 activates mode", () => {
	const original = process.env.GENTLE_PI_AUTONOMOUS_MODE;
	process.env.GENTLE_PI_AUTONOMOUS_MODE = "1";
	const dir = makeTmpDir();
	try {
		const config = __testing.loadRuntimeGuardrailsConfig(dir, {
			gentlePiConfigHome: join(dir, "global-config"),
		});
		assert.equal(config.autonomousMode, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		if (original === undefined) delete process.env.GENTLE_PI_AUTONOMOUS_MODE;
		else process.env.GENTLE_PI_AUTONOMOUS_MODE = original;
	}
});

test("loadRuntimeGuardrailsConfig: global config file activates autonomous mode", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		writeConfig(globalConfigDir, "runtime-guardrails.json", {
			autonomousMode: true,
			guardedCommands: { gitPush: "allow" },
		});
		const config = __testing.loadRuntimeGuardrailsConfig(join(dir, "project"), {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, true);
		assert.equal(config.guardedCommands.gitPush, "allow");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadRuntimeGuardrailsConfig: project config overrides global config", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		const projectDir = join(dir, "project");

		writeConfig(globalConfigDir, "runtime-guardrails.json", {
			autonomousMode: true,
			guardedCommands: { gitPush: "allow", npmPublish: "confirm" },
		});
		writeConfig(projectDir, join(".pi", "gentle-ai", "runtime-guardrails.json"), {
			autonomousMode: true,
			guardedCommands: { gitPush: "confirm", npmPublish: "block" },
		});

		const config = __testing.loadRuntimeGuardrailsConfig(projectDir, {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, true);
		assert.equal(config.guardedCommands.gitPush, "confirm");
		assert.equal(config.guardedCommands.npmPublish, "block");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadRuntimeGuardrailsConfig: invalid JSON in config fails safe (autonomousMode=false)", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		const configPath = join(globalConfigDir, "runtime-guardrails.json");
		mkdirSync(globalConfigDir, { recursive: true });
		writeFileSync(configPath, "{ not valid json }");

		const config = __testing.loadRuntimeGuardrailsConfig(join(dir, "project"), {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadRuntimeGuardrailsConfig: non-object JSON fails safe", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		writeConfig(globalConfigDir, "runtime-guardrails.json", [1, 2, 3]);

		const config = __testing.loadRuntimeGuardrailsConfig(join(dir, "project"), {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadRuntimeGuardrailsConfig: invalid project config fails safe (autonomousMode=false)", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		const projectDir = join(dir, "project");

		writeConfig(globalConfigDir, "runtime-guardrails.json", {
			autonomousMode: true,
			guardedCommands: { gitPush: "allow" },
		});
		const projectConfigPath = join(
			projectDir,
			".pi",
			"gentle-ai",
			"runtime-guardrails.json",
		);
		mkdirSync(dirname(projectConfigPath), { recursive: true });
		writeFileSync(projectConfigPath, "{ bad json }");

		const config = __testing.loadRuntimeGuardrailsConfig(projectDir, {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// When autonomous mode is OFF nothing changes vs current behavior
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: pi remove confirm when autonomousMode=false", () => {
	const result = classifyGuardedCommand("pi remove my-package", {
		autonomousMode: false,
		guardedCommands: { piRemove: "allow" },
	});
	assert.equal(result, "confirm");
});

test("classifyGuardedCommand: pi remove allowed when autonomousMode=true and piRemove=allow", () => {
	const result = classifyGuardedCommand("pi remove my-package", {
		autonomousMode: true,
		guardedCommands: { piRemove: "allow" },
	});
	assert.equal(result, "allow");
});

// ---------------------------------------------------------------------------
// Fix 1: git global flags bypass — git -C <dir> push / git --work-tree push
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: git -C /repo push --force → block even with gitPush=allow", () => {
	const result = classifyGuardedCommand("git -C /repo push --force origin main", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: git --work-tree=/tmp push --force → block", () => {
	const result = classifyGuardedCommand("git --work-tree=/tmp push --force origin main", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: git -C /repo push -f → block", () => {
	const result = classifyGuardedCommand("git -C /repo push -f origin main", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: git -C /repo push origin feat → classified as gitPush (allow when configured)", () => {
	const result = classifyGuardedCommand("git -C /repo push origin feat", {
		autonomousMode: true,
		guardedCommands: { gitPush: "allow" },
	});
	assert.equal(result, "allow");
});

test("classifyGuardedCommand: git -C /repo push origin feat → confirm when autonomousMode=false", () => {
	const result = classifyGuardedCommand("git -C /repo push origin feat", {
		autonomousMode: false,
		guardedCommands: {},
	});
	assert.equal(result, "confirm");
});

// ---------------------------------------------------------------------------
// Fix 2: rm -rf $HOME was not blocked (dead regex branch)
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: rm -rf $HOME → block", () => {
	const result = classifyGuardedCommand("rm -rf $HOME", {
		autonomousMode: true,
		guardedCommands: {},
	});
	assert.equal(result, "block");
});

test("classifyGuardedCommand: rm -rf $HOME/foo → block", () => {
	const result = classifyGuardedCommand("rm -rf $HOME/foo", {
		autonomousMode: true,
		guardedCommands: {},
	});
	assert.equal(result, "block");
});

// ---------------------------------------------------------------------------
// Fix 5a: gitBranchDeleteForce allow path is tested
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: gitBranchDeleteForce=allow in autonomous mode → allow", () => {
	const result = classifyGuardedCommand("git branch -D old-feature", {
		autonomousMode: true,
		guardedCommands: { gitBranchDeleteForce: "allow" },
	});
	assert.equal(result, "allow");
});

// ---------------------------------------------------------------------------
// Fix 5b: AUTONOMOUS_DEFAULT_ACTIONS fallback — empty guardedCommands in autonomous mode
// ---------------------------------------------------------------------------

test("classifyGuardedCommand: autonomousMode=true, empty guardedCommands, gitPush defaults to allow", () => {
	const result = classifyGuardedCommand("git push origin main", {
		autonomousMode: true,
		guardedCommands: {},
	});
	assert.equal(result, "allow");
});

// ---------------------------------------------------------------------------
// Fix 5c: env var negatives — only "1" activates autonomous mode
// ---------------------------------------------------------------------------

test("loadRuntimeGuardrailsConfig: GENTLE_PI_AUTONOMOUS_MODE=0 does NOT activate autonomous mode", () => {
	const original = process.env.GENTLE_PI_AUTONOMOUS_MODE;
	process.env.GENTLE_PI_AUTONOMOUS_MODE = "0";
	const dir = makeTmpDir();
	try {
		const config = __testing.loadRuntimeGuardrailsConfig(dir, {
			gentlePiConfigHome: join(dir, "global-config"),
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		if (original === undefined) delete process.env.GENTLE_PI_AUTONOMOUS_MODE;
		else process.env.GENTLE_PI_AUTONOMOUS_MODE = original;
	}
});

test("loadRuntimeGuardrailsConfig: GENTLE_PI_AUTONOMOUS_MODE=true does NOT activate autonomous mode", () => {
	const original = process.env.GENTLE_PI_AUTONOMOUS_MODE;
	process.env.GENTLE_PI_AUTONOMOUS_MODE = "true";
	const dir = makeTmpDir();
	try {
		const config = __testing.loadRuntimeGuardrailsConfig(dir, {
			gentlePiConfigHome: join(dir, "global-config"),
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		if (original === undefined) delete process.env.GENTLE_PI_AUTONOMOUS_MODE;
		else process.env.GENTLE_PI_AUTONOMOUS_MODE = original;
	}
});

test("loadRuntimeGuardrailsConfig: GENTLE_PI_AUTONOMOUS_MODE='' does NOT activate autonomous mode", () => {
	const original = process.env.GENTLE_PI_AUTONOMOUS_MODE;
	process.env.GENTLE_PI_AUTONOMOUS_MODE = "";
	const dir = makeTmpDir();
	try {
		const config = __testing.loadRuntimeGuardrailsConfig(dir, {
			gentlePiConfigHome: join(dir, "global-config"),
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		if (original === undefined) delete process.env.GENTLE_PI_AUTONOMOUS_MODE;
		else process.env.GENTLE_PI_AUTONOMOUS_MODE = original;
	}
});

// ---------------------------------------------------------------------------
// Fix 5d: JSON config autonomousMode strict === true check
// ---------------------------------------------------------------------------

test("loadRuntimeGuardrailsConfig: autonomousMode:1 (number) in JSON does NOT activate autonomous mode", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		writeConfig(globalConfigDir, "runtime-guardrails.json", {
			autonomousMode: 1,
			guardedCommands: {},
		});
		const config = __testing.loadRuntimeGuardrailsConfig(join(dir, "project"), {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('loadRuntimeGuardrailsConfig: autonomousMode:"true" (string) in JSON does NOT activate autonomous mode', () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		writeConfig(globalConfigDir, "runtime-guardrails.json", {
			autonomousMode: "true",
			guardedCommands: {},
		});
		const config = __testing.loadRuntimeGuardrailsConfig(join(dir, "project"), {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadRuntimeGuardrailsConfig: autonomousMode:{} (object) in JSON does NOT activate autonomous mode", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global-config");
		writeConfig(globalConfigDir, "runtime-guardrails.json", {
			autonomousMode: {},
			guardedCommands: {},
		});
		const config = __testing.loadRuntimeGuardrailsConfig(join(dir, "project"), {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.equal(config.autonomousMode, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
// evaluateBashPolicies — ordered bash command policy seam (gentle-pi#405 S1)
// ---------------------------------------------------------------------------

type BashPolicySeamArgs = Parameters<typeof __testing.evaluateBashPolicies>;

function makeBashPolicySeamHarness(cwd: string) {
	return {
		ctx: { cwd, hasUI: false, ui: {} } as BashPolicySeamArgs[1],
		events: { emit: () => {}, on: () => {} } as BashPolicySeamArgs[2],
		herdrLifecycle: {
			begin: () => {},
			settle: () => {},
		} as BashPolicySeamArgs[3],
	};
}

function makeStubBashPolicy(
	name: string,
	verdict: { block: true; reason: string } | undefined,
	calls: string[],
): NonNullable<BashPolicySeamArgs[4]>[number] {
	return {
		name,
		async evaluate(_command: string) {
			calls.push(name);
			return verdict;
		},
	};
}

test('evaluateBashPolicies: ordered policy list is exactly ["runtime-guardrails"]', () => {
	assert.deepEqual(
		__testing.BASH_COMMAND_POLICIES.map((policy) => policy.name),
		["runtime-guardrails"],
	);
	assert.ok(
		__testing.BASH_COMMAND_POLICIES.every(
			(policy) => typeof policy.evaluate === "function",
		),
		"every policy must expose an evaluate function",
	);
});

test("evaluateBashPolicies: short-circuits on the first verdict (later policies are not evaluated)", async () => {
	const calls: string[] = [];
	const firstVerdict = { block: true, reason: "first policy verdict" } as const;
	const seam = makeBashPolicySeamHarness("/stub-cwd");
	const result = await __testing.evaluateBashPolicies(
		"ignored by stubs",
		seam.ctx,
		seam.events,
		seam.herdrLifecycle,
		[
			makeStubBashPolicy("first", firstVerdict, calls),
			makeStubBashPolicy(
				"second",
				{ block: true, reason: "second policy verdict" },
				calls,
			),
		],
	);
	assert.deepEqual(result, firstVerdict);
	assert.deepEqual(
		calls,
		["first"],
		"the second policy must not run after a verdict",
	);
});

test("evaluateBashPolicies: allow verdict from the last policy returns undefined overall", async () => {
	const calls: string[] = [];
	const seam = makeBashPolicySeamHarness("/stub-cwd");
	const result = await __testing.evaluateBashPolicies(
		"ignored by stubs",
		seam.ctx,
		seam.events,
		seam.herdrLifecycle,
		[
			makeStubBashPolicy("first-allow", undefined, calls),
			makeStubBashPolicy("last-allow", undefined, calls),
		],
	);
	assert.equal(result, undefined);
	assert.deepEqual(
		calls,
		["first-allow", "last-allow"],
		"an allow must not short-circuit remaining policies",
	);
});

test("evaluateBashPolicies: real runtime-guardrails policy blocks hard-deny commands through the seam", async () => {
	const dir = makeTmpDir();
	const originalConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = join(dir, "config-home");
	try {
		const seam = makeBashPolicySeamHarness(dir);
		const result = await __testing.evaluateBashPolicies(
			"rm -rf /",
			seam.ctx,
			seam.events,
			seam.herdrLifecycle,
		);
		assert.equal(result?.block, true);
		assert.match(result?.reason ?? "", /destructive/);
	} finally {
		if (originalConfigHome === undefined)
			delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = originalConfigHome;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("evaluateBashPolicies: real runtime-guardrails policy allows a non-guarded command through the seam", async () => {
	const dir = makeTmpDir();
	const originalConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = join(dir, "config-home");
	try {
		const seam = makeBashPolicySeamHarness(dir);
		const result = await __testing.evaluateBashPolicies(
			"echo hello",
			seam.ctx,
			seam.events,
			seam.herdrLifecycle,
		);
		assert.equal(result, undefined);
	} finally {
		if (originalConfigHome === undefined)
			delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = originalConfigHome;
		rmSync(dir, { recursive: true, force: true });
	}
});
