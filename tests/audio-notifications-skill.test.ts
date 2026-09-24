import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/skill-registry.ts";

const repoRoot = join(import.meta.dirname, "..");
const skillDir = join(repoRoot, "skills", "audio-notifications");
const skillPath = join(skillDir, "SKILL.md");
const scriptPath = join(skillDir, "assets", "avisame.sh");

test("gentle-ai-audio-notifications SKILL.md structure and frontmatter validity", () => {
	assert.ok(existsSync(skillPath), "SKILL.md must exist");
	const content = readFileSync(skillPath, "utf8");
	const frontmatter = __testing.parseFrontmatter(content);

	assert.equal(frontmatter.name, "gentle-ai-audio-notifications");
	assert.match(frontmatter.description, /Trigger:/);
	assert.match(frontmatter.description, /avisame/);
	assert.match(frontmatter.description, /earcon/);
	assert.match(frontmatter.description, /audio/);

	// Section contracts
	assert.match(content, /## Activation Contract/);
	assert.match(content, /## Hard Rules/);
	assert.match(content, /## Earcon Sound Mappings/);
	assert.match(content, /## Decision Gates/);
	assert.match(content, /## Execution Steps/);
	assert.match(content, /## Output Contract/);
	assert.match(content, /## References/);
});

test("avisame.sh wrapper script exists and is executable", () => {
	assert.ok(existsSync(scriptPath), "avisame.sh must exist");
	if (process.platform !== "win32") {
		const stat = statSync(scriptPath);
		assert.ok((stat.mode & 0o111) !== 0, "avisame.sh must have executable bit set");
	}
});

test("avisame.sh wraps commands, preserves stdout/stderr and exit codes", () => {
	// Success wrapping
	const successRun = spawnSync(scriptPath, ["bash", "-c", "echo 'stdout line'; echo 'stderr line' >&2; exit 0"], {
		encoding: "utf8",
	});
	assert.equal(successRun.status, 0);
	assert.match(successRun.stdout, /stdout line/);
	assert.match(successRun.stderr, /stderr line/);

	// Error wrapping with arbitrary exit code
	const errorRun = spawnSync(scriptPath, ["bash", "-c", "echo 'failing'; exit 42"], {
		encoding: "utf8",
	});
	assert.equal(errorRun.status, 42);
	assert.match(errorRun.stdout, /failing/);
});

test("avisame.sh semantic event flags behave correctly", () => {
	// --start
	const startRun = spawnSync(scriptPath, ["--start", "Starting build"], { encoding: "utf8" });
	assert.equal(startRun.status, 0);

	// --success
	const successRun = spawnSync(scriptPath, ["--success", "Build succeeded"], { encoding: "utf8" });
	assert.equal(successRun.status, 0);

	// --fanfare / --batch-done
	const fanfareRun = spawnSync(scriptPath, ["--fanfare", "Batch finished"], { encoding: "utf8" });
	assert.equal(fanfareRun.status, 0);
	const batchDoneRun = spawnSync(scriptPath, ["--batch-done", "All tasks done"], { encoding: "utf8" });
	assert.equal(batchDoneRun.status, 0);

	// --error exits 1
	const errorRun = spawnSync(scriptPath, ["--error", "Build failed"], { encoding: "utf8" });
	assert.equal(errorRun.status, 1);

	// Single message argument fallback
	const messageRun = spawnSync(scriptPath, ["Simple reminder"], { encoding: "utf8" });
	assert.equal(messageRun.status, 0);
});
