import assert from "node:assert/strict";
import { execSync, spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/skill-registry.ts";

const repoRoot = join(import.meta.dirname, "..");
const skillDir = join(repoRoot, "skills", "audio-notifications");
const skillPath = join(skillDir, "SKILL.md");
const scriptPath = join(skillDir, "assets", "notify.sh");

const isWindows = process.platform === "win32";
const hasBash = !isWindows || spawnSync("bash", ["-c", "exit 0"]).status === 0;

/**
 * Executes notify.sh with given arguments, invoking bash on Windows platforms.
 */
function runNotify(args: string[], options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {}) {
	const opts: SpawnSyncOptionsWithStringEncoding = { ...options, encoding: "utf8" };
	if (isWindows) {
		return spawnSync("bash", [scriptPath, ...args], opts);
	}
	return spawnSync(scriptPath, args, opts);
}

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

test("notify.sh wrapper script exists and is executable", () => {
	assert.ok(existsSync(scriptPath), "notify.sh must exist");
	if (process.platform !== "win32") {
		const stat = statSync(scriptPath);
		assert.ok((stat.mode & 0o111) !== 0, "notify.sh must have executable bit set");
	}
});

test("notify.sh wraps commands, preserves stdout/stderr and exit codes", { skip: isWindows && !hasBash ? "bash unavailable on Windows" : false }, () => {
	// Success wrapping
	const successRun = runNotify(["bash", "-c", "echo 'stdout line'; echo 'stderr line' >&2; exit 0"]);
	assert.equal(successRun.status, 0);
	assert.match(successRun.stdout, /stdout line/);
	assert.match(successRun.stderr, /stderr line/);

	// Error wrapping with arbitrary exit code
	const errorRun = runNotify(["bash", "-c", "echo 'failing'; exit 42"]);
	assert.equal(errorRun.status, 42);
	assert.match(errorRun.stdout, /failing/);

	// Preserves non-zero exit when wrapped command is not found
	const missingCmdRun = runNotify(["__nonexistent_binary_xyz_12345__"]);
	assert.notEqual(missingCmdRun.status, 0);
});

test("notify.sh semantic event flags behave correctly", { skip: isWindows && !hasBash ? "bash unavailable on Windows" : false }, () => {
	// --start
	const startRun = runNotify(["--start", "Starting build"]);
	assert.equal(startRun.status, 0);

	// --success
	const successRun = runNotify(["--success", "Build succeeded"]);
	assert.equal(successRun.status, 0);

	// --fanfare / --batch-done
	const fanfareRun = runNotify(["--fanfare", "Batch finished"]);
	assert.equal(fanfareRun.status, 0);
	const batchDoneRun = runNotify(["--batch-done", "All tasks done"]);
	assert.equal(batchDoneRun.status, 0);

	// --error exits 1
	const errorRun = runNotify(["--error", "Build failed"]);
	assert.equal(errorRun.status, 1);

	// --title without value fails fast instead of looping
	const titleMissingRun = runNotify(["--title"]);
	assert.equal(titleMissingRun.status, 2);
	assert.match(titleMissingRun.stderr, /requires a value/);
});

test("notify.sh exports WSLENV with /w flag for Win32 PowerShell bridging", () => {
	const scriptContent = readFileSync(scriptPath, "utf8");
	assert.match(
		scriptContent,
		/WSLENV=.*GENTLE_NOTIFY_TITLE\/w:GENTLE_NOTIFY_MSG\/w/,
		"WSLENV must use /w flag to forward notification env variables from WSL to Win32 PowerShell",
	);
});
