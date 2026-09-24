import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	renderSddPreflightPrompt,
	type SddPreflightPreferences,
} from "../lib/sdd-preflight.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEXT_EXTENSIONS = new Set([".md", ".ts", ".mjs", ".json"]);

async function collectTextFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectTextFiles(path)));
			continue;
		}
		if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) {
			files.push(path);
		}
	}
	return files;
}

const SPANISH_PREFLIGHT_COPY = [
	/Antes de continuar con SDD/i,
	/Antes de seguir con SDD/i,
	/una opci[oó]n por grupo/i,
	/usar recomendad[oa]/i,
	/\bRitmo\b/i,
	/\bArtefactos\b/i,
	/\bPreguntarme\b/i,
	/l[ií]neas cambiadas/i,
	/\bhacelo\b/i,
	/\bSoy el Gentleman\b/i,
];

test("orchestrator keeps conversation language separate from generated artifact language", async () => {
	const orchestrator = await readFile(join(ROOT, "assets/orchestrator.md"), "utf8");

	// persona-single-channel: the conversation-language rule (previously a duplicated
	// LB1 sentence here) now lives once, in the wrapper block (gentle-ai.ts), and this
	// section only carries a one-line pointer back to it.
	assert.match(
		orchestrator,
		/Reply-language style and the active persona's Spanish variant are defined once in the identity\/harness section above/,
	);
	assert.match(
		orchestrator,
		/Generated technical artifacts[\s\S]*default to English, regardless of the user's conversation language or active persona/,
	);
	for (const artifactScope of ["code comments", "tests", "fixtures", "delegated phase outputs"]) {
		assert.match(orchestrator, new RegExp(artifactScope));
	}
	assert.match(
		orchestrator,
		/Public\/contextual comments and replies[\s\S]*target context language by default/,
	);
});

test("rendered SDD preflight prompt is English artifact copy", () => {
	const prefs: SddPreflightPreferences = {
		executionMode: "interactive",
		artifactStore: "openspec",
		chainedPrStrategy: "ask-on-risk",
		reviewBudgetLines: 400,
		engramAvailable: false,
		prompted: true,
	};
	const prompt = renderSddPreflightPrompt(prefs);

	assert.match(prompt, /These SDD preferences are explicit current-session choices/);
	assert.match(prompt, /Delivery strategy: ask-on-risk/);
	assert.match(prompt, /Review budget: 400 changed lines/);
	assert.match(prompt, /complete only the current SDD phase/i);
	assert.match(prompt, /Do not start the next SDD phase/i);
	assert.match(prompt, /approve only the immediate next phase/i);
	assert.match(prompt, /offer the user a proposal question round/i);
	assert.match(prompt, /business rules, implications, impact, edge cases/i);
	assert.match(prompt, /second question round/i);
	assert.match(prompt, /explicit acceptance of `size:exception`/);
	assert.match(prompt, /human-controlled consent, authorization, security, destructive\/publishing/);
	for (const pattern of SPANISH_PREFLIGHT_COPY) {
		assert.doesNotMatch(prompt, pattern);
	}

	const headless = renderSddPreflightPrompt({ ...prefs, executionMode: "auto", prompted: false });
	assert.match(headless, /canonical defaults or persisted choices/);
	assert.match(headless, /ambiguous-scope/);
});

test("orchestrator Memory Contract carries the Engram memory lifecycle rule", async () => {
	// orchestrator-lazy-diet: the lifecycle rule moved verbatim to
	// assets/orchestrator-memory.md; core keeps only the intro + pointer.
	// Union read so this assertion is repointed, not weakened.
	const orchestrator =
		(await readFile(join(ROOT, "assets/orchestrator.md"), "utf8")) +
		(await readFile(join(ROOT, "assets/orchestrator-memory.md"), "utf8"));

	// Mirrors gentle-ai's engram-protocol/engram-convention lifecycle rule (PRs #842 + #844),
	// in its final availability-gated form: agents must treat needs_review memories as stale,
	// use the memory-provider-injected lifecycle tool when present, fall back safely when it is not,
	// and never auto-mark reviewed.
	for (const required of [
		"when Engram exposes lifecycle metadata/tooling",
		"At session start or before architecture-sensitive work",
		"call the injected Engram review tool with action `list`",
		"for the current project when the tool is available",
		"If the injected Engram review tool is unavailable, do not fail the task",
		"Continue with the injected Engram context/search tools",
		"still apply lifecycle metadata from any returned observations when present",
		"`active` memories may be used normally",
		"`needs_review` memories are stale context, not trusted facts",
		"verify it against current evidence before relying on it",
		"Do NOT call the injected Engram review tool with action `mark_reviewed` automatically",
		"Only call `mark_reviewed` after explicit user confirmation or through a dedicated memory maintenance command",
	]) {
		assert.ok(
			orchestrator.includes(required),
			`orchestrator.md missing memory lifecycle rule: ${required}`,
		);
	}
});

test("SDD proposal questions focus on business and PRD gaps", async () => {
	const proposalAgent = await readFile(join(ROOT, "assets/agents/sdd-proposal.md"), "utf8");

	assert.match(proposalAgent, /offer the user a proposal question round/i);
	assert.match(proposalAgent, /second question round/i);
	assert.match(proposalAgent, /business problem/i);
	assert.match(proposalAgent, /business rules/i);
	assert.match(proposalAgent, /implications and impact/i);
	assert.match(proposalAgent, /edge cases/i);
	assert.match(proposalAgent, /target users/i);
	assert.match(proposalAgent, /product outcome/i);
	assert.match(proposalAgent, /decision gaps/i);
	// Proposal-shaping questions must stay on business/product ground: the agent is
	// explicitly told to keep harness mechanics out of the proposal question round
	// unless the user opts into discussing delivery. Removing this guard is the most
	// likely way harness mechanics would leak back into proposal questions.
	assert.match(
		proposalAgent,
		/Do not ask about test commands, PR shape, changed-line budget, or other harness decisions unless the user explicitly asks to discuss delivery/i,
	);
});

test("all shipped SDD agents and chains require parent preflight transport", async () => {
	const agents = [
		"sdd-init", "sdd-onboard", "sdd-explore", "sdd-research", "sdd-proposal", "sdd-spec", "sdd-design",
		"sdd-tasks", "sdd-status", "sdd-apply", "sdd-verify", "sdd-archive", "sdd-remediate",
	];
	const chains = ["sdd-full", "sdd-plan", "sdd-verify"];
	assert.equal(agents.length, 13);
	assert.equal(chains.length, 3);
	for (const agent of agents) {
		const source = await readFile(join(ROOT, "assets", "agents", `${agent}.md`), "utf8");
		assert.match(source, /## Parent Preflight Transport/);
		assert.match(source, /never confirms or persists SDD choices/);
		assert.doesNotMatch(source, /(?:infer|synthesize) (?:a )?(?:preflight )?(?:confirmation|defaults?) yourself/i);
	}
	for (const chain of chains) {
		const source = await readFile(join(ROOT, "assets", "chains", `${chain}.chain.md`), "utf8");
		assert.match(source, /## Parent preflight transport guard/);
		assert.match(source, /Missing or malformed transport blocks the chain before its first phase/);
	}
});

test("SDD chain assets distinguish interactive gates from auto execution", async () => {
	const planChain = await readFile(join(ROOT, "assets/chains/sdd-plan.chain.md"), "utf8");
	const fullChain = await readFile(join(ROOT, "assets/chains/sdd-full.chain.md"), "utf8");

	assert.match(planChain, /auto mode or explicit all-planning approval/i);
	assert.match(planChain, /interactive mode/i);
	assert.match(planChain, /must stop after sdd-proposal/i);
	assert.match(fullChain, /auto mode or explicit full-lifecycle approval/i);
	assert.match(fullChain, /interactive mode/i);
	assert.match(fullChain, /must stop at each phase boundary/i);
});

test("orchestrator lazy-loads detailed SDD workflow", async () => {
	const orchestrator = await readFile(join(ROOT, "assets/orchestrator.md"), "utf8");
	const workflow = await readFile(join(ROOT, "assets/sdd-orchestrator-workflow.md"), "utf8");

	assert.match(orchestrator, /## SDD Workflow \(lazy-loaded\)/);
	assert.match(orchestrator, /Package assets root: `\{\{GENTLE_PI_ASSETS_ROOT\}\}`\. Lazy asset paths below are relative to this root\./);
	assert.match(orchestrator, /`sdd-orchestrator-workflow\.md`/);
	assert.doesNotMatch(orchestrator, /\{\{GENTLE_PI_SDD_WORKFLOW_PATH\}\}/);
	assert.match(orchestrator, /injected `## SDD Session Preflight` block or a canonical-authority resolution/);
	assert.match(orchestrator, /Defaults and capability constraints may resolve fields without confirmation prompts/);
	assert.doesNotMatch(orchestrator, /or an explicit user answer covering the preflight choices/);
	assert.doesNotMatch(orchestrator, /## Native SDD Dispatcher/);
	assert.match(workflow, /## Native SDD Dispatcher/);
	assert.match(workflow, /## SDD Status Contract/);
	assert.match(workflow, /## Execution Mode/);
	assert.match(workflow, /## Strict TDD Forwarding/);
	assert.match(workflow, /## Review Workload Guard/);
	assert.match(workflow, /## Result Contract/);
});

test("persistent harness prompt assets do not hardcode Spanish SDD artifact copy", async () => {
	const files = [
		...(await collectTextFiles(join(ROOT, "assets"))),
		...(await collectTextFiles(join(ROOT, "prompts"))),
	];
	const failures: string[] = [];

	for (const file of files) {
		const text = await readFile(file, "utf8");
		for (const pattern of SPANISH_PREFLIGHT_COPY) {
			if (pattern.test(text)) {
				failures.push(`${relative(ROOT, file)} matched ${pattern}`);
			}
		}
	}

	assert.deepEqual(failures, []);
});

test("SDD assets route completed implementation through native archive with optional verification", async () => {
	const [tasks, apply, status, contract, chain] = await Promise.all([
		readFile(join(ROOT, "assets/agents/sdd-tasks.md"), "utf8"),
		readFile(join(ROOT, "assets/agents/sdd-apply.md"), "utf8"),
		readFile(join(ROOT, "assets/agents/sdd-status.md"), "utf8"),
		readFile(join(ROOT, "assets/support/sdd-status-contract.md"), "utf8"),
		readFile(join(ROOT, "assets/chains/sdd-full.chain.md"), "utf8"),
	]);
	const assets = [tasks, apply, status, contract, chain].join("\n");

	assert.match(tasks, /- \[ \] 1\. Implement and verify the behavior\./);
	assert.doesNotMatch(tasks, /<!-- sdd-owner:/);
	assert.match(apply, /fresh native recommendation/);
	assert.match(status, /gentle-ai\.sdd-status.*v2/i);
	assert.match(status, /read-only/i);
	assert.match(contract, /native.*(?:apply|verify).*archive/is);
	assert.doesNotMatch(contract, /local resolver/);
	assert.match(contract, /verification is optional/);
	assert.match(chain, /apply -> archive/);
	assert.doesNotMatch(chain, /^## sdd-(verify|sync)$/m);
	assert.doesNotMatch(assets, /<!-- sdd-owner: parent -->/);
	assert.doesNotMatch(assets, /parent-lifecycle/);
	assert.doesNotMatch(assets, /approved receipt|bounded review/i);
	assert.doesNotMatch(chain, /## sdd-review/);
});

test("comment-writer is context-reactive and neutral by default for Spanish comments", async () => {
	const skill = await readFile(join(ROOT, "skills/comment-writer/SKILL.md"), "utf8");

	for (const required of [
		"target context language",
		"explicitly requests a language",
		"neutral/professional Spanish by default",
	]) {
		assert.match(skill, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}

	for (const regionalDefault of [
		/\bAcá\b/,
		/\bagregá\b/,
		/\bpodés\b/,
		/\btenés\b/,
		/\bfijate\b/,
		/\bdale\b/,
		/\bquerés\b/i,
	]) {
		assert.doesNotMatch(skill, regionalDefault);
	}

	for (const englishExample of [
		"Good approach overall",
		"Approved. The scope is clear",
		"This PR exceeds the 400-line budget",
	]) {
		assert.match(skill, new RegExp(englishExample.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});
