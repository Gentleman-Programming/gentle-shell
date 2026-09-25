import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEXT_EXTENSIONS = new Set([".md", ".ts", ".mjs", ".json"]);

async function collectTextFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await collectTextFiles(path)));
		else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) files.push(path);
	}
	return files;
}

const SPANISH_ARTIFACT_COPY = [/\bhacelo\b/i, /\bSoy el Gentleman\b/i];

test("ordinary startup does not load the retired SDD preflight API", async () => {
	const extension = await readFile(join(ROOT, "extensions/gentle-ai.ts"), "utf8");
	assert.doesNotMatch(extension, /\b(?:ensureSddPreflight|getSddPreflightPreferences|isSddPreflightTrigger|renderSddPreflightPrompt|isParentConfirmedSddPreflightContext)\b/);
});

test("orchestrator keeps conversation language separate from generated artifact language", async () => {
	const orchestrator = await readFile(join(ROOT, "assets/orchestrator.md"), "utf8");
	assert.match(orchestrator, /Reply-language style and the active persona's Spanish variant are defined once in the identity\/harness section above/);
	assert.match(orchestrator, /Generated technical artifacts[\s\S]*default to English, regardless of the user's conversation language or active persona/);
	for (const artifactScope of ["code comments", "tests", "fixtures", "delegated outputs"]) {
		assert.match(orchestrator, new RegExp(artifactScope));
	}
	assert.match(orchestrator, /Public\/contextual comments and replies[\s\S]*target context language by default/);
});

test("orchestrator Memory Contract carries the Engram memory lifecycle rule", async () => {
	const orchestrator =
		(await readFile(join(ROOT, "assets/orchestrator.md"), "utf8")) +
		(await readFile(join(ROOT, "assets/orchestrator-memory.md"), "utf8"));
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
		assert.ok(orchestrator.includes(required), `orchestrator.md missing memory lifecycle rule: ${required}`);
	}
});

test("persistent harness prompt assets use English artifact copy", async () => {
	const files = [
		...(await collectTextFiles(join(ROOT, "assets"))),
		...(await collectTextFiles(join(ROOT, "prompts"))),
	];
	const failures: string[] = [];
	for (const file of files) {
		const text = await readFile(file, "utf8");
		for (const pattern of SPANISH_ARTIFACT_COPY) {
			if (pattern.test(text)) failures.push(`${relative(ROOT, file)} matched ${pattern}`);
		}
	}
	assert.deepEqual(failures, []);
});

test("comment-writer is context-reactive and neutral by default for Spanish comments", async () => {
	const skill = await readFile(join(ROOT, "skills/comment-writer/SKILL.md"), "utf8");
	for (const required of ["target context language", "explicitly requests a language", "neutral/professional Spanish by default"]) {
		assert.match(skill, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	for (const regionalDefault of [/\bAcá\b/, /\bagregá\b/, /\bpodés\b/, /\btenés\b/, /\bfijate\b/, /\bdale\b/, /\bquerés\b/i]) {
		assert.doesNotMatch(skill, regionalDefault);
	}
	for (const englishExample of ["Good approach overall", "Approved. The scope is clear", "This PR exceeds the 400-line budget"]) {
		assert.match(skill, new RegExp(englishExample.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});
