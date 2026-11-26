import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// harness-continuity T10 (S6/S8/S9, retained verifier probes): across every persona, workflow mode and RDD state, no
// rendered prompt, lazy module or generic agent revives the retired terminal phrase or the mandatory Key Learnings
// ritual, and the provider-defect stub stays safe when its skill is unavailable. Contract text only.
const ROOT = join(import.meta.dirname, "..");
process.env.GENTLE_PI_CONFIG_HOME = join(mkdtempSync(join(tmpdir(), "db-")), "cfg");
const STATUSES = ["Receipt-driven development: on (decided by global)", "Receipt-driven development: off (decided by global)", undefined];

test("S6/S8: no rendered prompt, lazy module, or generic agent licenses the retired phrase or ritual", () => {
	const texts: string[] = [];
	for (const persona of ["gentleman", "neutral"] as const) for (const mode of ["organic", "full-delegation"] as const) for (const status of STATUSES)
		texts.push(__testing.buildGentlePrompt(persona, join(tmpdir(), "x"), ["read", "bash", "edit", "write", "subagent_run"], status, undefined, mode));
	for (const file of readdirSync(join(ROOT, "assets")).filter((name) => name.startsWith("orchestrator") && name.endsWith(".md"))) texts.push(readFileSync(join(ROOT, "assets", file), "utf8"));
	for (const agent of ["gentle-ai-worker.md", "gentle-ai-explore.md", "gentle-ai-verify.md"]) texts.push(readFileSync(join(ROOT, "assets", "agents", agent), "utf8"));
	for (const text of texts) {
		assert.ok(!text.includes("Needs your decision"));
		assert.ok(!text.includes("Key Learnings"));
	}
	const verification = readFileSync(join(ROOT, "assets", "orchestrator-verification.md"), "utf8");
	assert.ok(verification.includes("Worker progress is separate from explicit setup, recheck, native and user limits; changed state earns a fresh check, not a reset."));
});

test("S9: the provider-defect stub stays safe when the report skill is unavailable", () => {
	const prompts = readFileSync(join(ROOT, "assets", "orchestrator-prompts.md"), "utf8");
	assert.ok(prompts.includes("If that skill is unavailable, file no report, open no consent prompt, and run no GitHub operation; tell the user the defect-report skill is not available and keep the evidence."));
});
