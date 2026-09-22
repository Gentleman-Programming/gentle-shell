import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// gentle-shell#348 — slice 1 (repro): the parent-inline skill contract gap.
//
// Deterministic reproduction, expected to PASS on unmodified main:
//
// 1. A project skill with an `## Output Contract` body is indexed by the
//    gentle-ai skill registry (discovery succeeds — `.atl/skill-registry.md`
//    lists it with scope `project`).
// 2. The composed parent prompt (the exact `buildGentlePrompt` composition the
//    primary session's `before_agent_start` handler injects) only binds
//    SUBAGENTS to read the exact indexed `SKILL.md` ("subagents read those
//    `SKILL.md` files first"). It imposes no parent-inline read obligation:
//    there is no "Parent inline execution" section and no wording binding the
//    parent's own inline path to read the indexed `SKILL.md` in-session.
// 3. Consequently the skill's contract body marker can never reach
//    parent-inline results through the composed prompt.
//
// Slice 2 must flip exactly the two guarded helpers below:
//   `assertParentPromptHasNoInlineSkillReadObligation` (the c-check) and
//   `assertParentPromptOmitsSkillContractBody` (the d-check).
//
// Harness: same accepted offline runtime pattern as
// tests/asset-installation-runtime.test.ts — the parent test builds a throwaway
// HOME + agent dir + project (all under one mkdtemp root), spawns this file as
// a child with a fully scoped env (no network, in-memory settings), and the
// child boots the real SDK session with the gentle-ai extension active.
// ---------------------------------------------------------------------------

const FIXTURE_MARKER = "FIXTURE348-CONTRACT-MARK";
const FIXTURE_SKILL_NAME = "fixture-contract-probe";
const CHILD_FLAG = "GENTLE_PI_348_INLINE_PROBE_CHILD";

const FIXTURE_SKILL_SOURCE = `---
name: ${FIXTURE_SKILL_NAME}
description: Probe skill for gentle-shell#348 inline contract reproduction.
---

# Fixture Contract Probe

## Output Contract

Every result produced under this skill MUST include the literal marker
${FIXTURE_MARKER} on its own line. This contract lives only in the indexed
SKILL.md body; the registry index carries name, description, and path —
never this body.
`;

function extensionSourceUrl(name: string): string {
	return JSON.stringify(new URL(`../extensions/${name}.ts`, import.meta.url).href);
}

function buildShimSource(): string {
	// Loads only what the repro needs from the packaged extensions directory:
	// the gentle-ai extension (primary-session orchestrator prompt + session
	// lifecycle) and the skill-registry extension (project skill discovery).
	return `
import { createGentleAiExtension } from ${extensionSourceUrl("gentle-ai")};
import skillRegistry from ${extensionSourceUrl("skill-registry")};
export default function (pi) {
  createGentleAiExtension({ nativeReviewCli: null, candidateViews: null, processEnv: {} })(pi);
  skillRegistry(pi);
}
`;
}

// --- guarded flip targets for slice 2 -------------------------------------

// c-check: the composed parent prompt must not bind the parent's OWN inline
// execution path to reading the indexed `SKILL.md` in-session. On main only
// subagents owe that read (the asymmetry under test). Slice 2 inverts this
// helper (or narrows its patterns) once the prompt carries the obligation.
function assertParentPromptHasNoInlineSkillReadObligation(prompt: string): void {
	const patterns: readonly RegExp[] = [
		/parent[ -]inline[ -]execution/i,
		/inline[^.\n]{0,120}`SKILL\.md`/i,
		/`SKILL\.md`[^.\n]{0,120}inline/i,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(prompt);
		const line = match === null ? "" : prompt.split("\n").find((l) => pattern.test(l)) ?? "";
		assert.ok(
			match === null,
			`composed parent prompt binds the inline path to SKILL.md reading via /${pattern.source}/: ${JSON.stringify(line.trim())}`,
		);
	}
}

// d-check: the fixture skill's contract body never reaches the composed parent
// prompt (the registry indexes metadata only). Slice 2 flips this helper if
// contract bodies start being delivered inline; otherwise it stays a guard.
function assertParentPromptOmitsSkillContractBody(prompt: string, marker: string): void {
	assert.ok(
		!prompt.includes(marker),
		`composed parent prompt leaked the indexed SKILL.md contract body (marker ${marker})`,
	);
}

// ---------------------------------------------------------------------------

async function proveInlineSkillContractGap(): Promise<void> {
	const {
		createAgentSessionFromServices,
		createAgentSessionRuntime,
		createAgentSessionServices,
		ModelRuntime,
		SessionManager,
		SettingsManager,
	} = await import("@earendil-works/pi-coding-agent");

	const projectDir = process.env.GENTLE_PI_348_PROJECT!;
	const shimPath = process.env.GENTLE_PI_348_SHIM!;
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const cwd = projectDir;

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "empty-auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
	});

	const runtime = await createAgentSessionRuntime(
		async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime,
				settingsManager: SettingsManager.inMemory({
					retry: { enabled: false },
					compaction: { enabled: false },
				}),
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					additionalExtensionPaths: [shimPath],
				},
			});
			// e-check: the real session boots with zero extension errors and
			// zero diagnostics, so any prompt-shape finding below is not an
			// artifact of a broken boot.
			assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
			assert.deepEqual(services.diagnostics, []);
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					tools: ["read", "bash"],
				})),
				services,
				diagnostics: services.diagnostics,
			};
		},
		{ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
	);

	try {
		await runtime.session.bindExtensions({ mode: "print" });
		const session = runtime.session;

		// a-check (discovery): force the live extension to regenerate the
		// registry, then prove the fixture project skill is indexed. The slash
		// command runs without a model turn, exactly like the accepted harness
		// pattern's /gentle:install-sdd step.
		await session.prompt("/skill-registry:refresh");
		assert.equal(session.messages.length, 0, "slash activation must not start a model turn");

		const registryPath = join(cwd, ".atl", "skill-registry.md");
		assert.ok(existsSync(registryPath), "skill registry must be regenerated in the project");
		const registry = readFileSync(registryPath, "utf8");
		assert.ok(
			registry.includes(`\`${FIXTURE_SKILL_NAME}\``),
			`registry must index the fixture skill: ${FIXTURE_SKILL_NAME}`,
		);
		assert.ok(
			registry.includes(`skills/${FIXTURE_SKILL_NAME}/SKILL.md`),
			"registry must carry the fixture SKILL.md path",
		);
		assert.match(registry, /\| project \|/, "fixture skill must be scoped to the project");

		// Fixture self-check: the contract marker lives in the indexed body.
		const skillBody = readFileSync(
			join(cwd, "skills", FIXTURE_SKILL_NAME, "SKILL.md"),
			"utf8",
		);
		assert.ok(skillBody.includes(FIXTURE_MARKER), "fixture must carry the contract marker");
		assert.ok(
			!registry.includes(FIXTURE_MARKER),
			"registry index must not inline skill bodies (it carries metadata only)",
		);

		// Composed parent prompt capture: `buildGentlePrompt` is the exact
		// composition the primary session's `before_agent_start` handler
		// injects (persona, cwd, active tool names, RDD status line). With
		// `nativeReviewCli: null` the resolved RDD line equals the default
		// worst-case "unknown" line, so this call reproduces the boot
		// composition for the primary session byte-for-byte. The module
		// instance is shared with the shim (same absolute path), and
		// `getOrchestratorPrompt` memoization is per background-policy key —
		// irrelevant here because this repro asserts prompt content, not
		// per-cwd variance.
		const { __testing } = await import("../extensions/gentle-ai.ts");
		const toolNames = session.agent.state.tools.map((tool) => tool.name);
		const prompt = __testing.buildGentlePrompt("gentleman", cwd, toolNames);

		// Fidelity pin: the render actually went through the composition
		// pipeline (assets root substitution + background/RDD status block).
		assert.match(
			prompt,
			/Receipt-driven development: unknown \(native status unavailable\)/,
			"captured prompt must be the composed render, not raw asset bytes",
		);
		assert.doesNotMatch(prompt, /\{\{/, "composed prompt must have every placeholder resolved");

		// b-check (asymmetry baseline): the subagent-directed read clause IS
		// delivered to the parent prompt — subagents owe the exact read.
		assert.match(
			prompt,
			/subagents read those `SKILL\.md` files first/,
			"parent prompt must carry the subagent-directed SKILL.md read clause",
		);

		// c-check + d-check: the gap. No parent-inline read obligation, and
		// the indexed contract body never reaches parent context.
		assertParentPromptHasNoInlineSkillReadObligation(prompt);
		assertParentPromptOmitsSkillContractBody(prompt, FIXTURE_MARKER);

		console.log(
			"inline-skill-probe: fixture indexed (project) -> composed parent prompt has the subagent-only SKILL.md read clause, no parent-inline obligation, no contract body",
		);
	} finally {
		await runtime.dispose();
	}
}

if (process.env[CHILD_FLAG] === "1") {
	await proveInlineSkillContractGap();
} else {
	test("gentle-shell#348 slice 1: registry-indexed skill contract cannot reach the parent-inline path", () => {
		const root = mkdtempSync(join(tmpdir(), "gentle-pi-348-probe-"));
		try {
			const home = join(root, "home");
			const projectDir = join(root, "project");
			const agentDir = join(home, ".pi", "agent");
			const skillDir = join(projectDir, "skills", FIXTURE_SKILL_NAME);
			for (const path of [projectDir, agentDir, skillDir]) {
				mkdirSync(path, { recursive: true });
			}
			writeFileSync(join(skillDir, "SKILL.md"), FIXTURE_SKILL_SOURCE);

			const shimPath = join(root, "shim", "extensions.ts");
			mkdirSync(dirname(shimPath), { recursive: true });
			writeFileSync(shimPath, buildShimSource());

			const result = spawnSync(
				process.execPath,
				["--experimental-strip-types", fileURLToPath(import.meta.url)],
				{
					cwd: projectDir,
					encoding: "utf8",
					timeout: 120_000,
					env: {
						PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
						HOME: home,
						TMPDIR: root,
						PI_CODING_AGENT_DIR: agentDir,
						GENTLE_PI_AGENT_HOME: agentDir,
						GENTLE_PI_CONFIG_HOME: join(home, "config"),
						XDG_CONFIG_HOME: join(home, ".config"),
						PI_OFFLINE: "1",
						GENTLE_PI_348_PROJECT: projectDir,
						GENTLE_PI_348_SHIM: shimPath,
						[CHILD_FLAG]: "1",
					},
				},
			);
			assert.ifError(result.error);
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
			assert.match(result.stdout, /inline-skill-probe: fixture indexed/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
