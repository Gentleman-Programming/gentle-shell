import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { parseAgentDefinition } from "../lib/agents-config.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const scratch = mkdtempSync(join(tmpdir(), "gentle-t7-recovery-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const workerPath = "assets/agents/gentle-ai-worker.md";
const worker = parseAgentDefinition(read(workerPath), workerPath, "global");
assert.ok(!("error" in worker));
const verification = read("assets/orchestrator-verification.md");
const quota = read("assets/orchestrator-quota-recovery.md");
const fullDelegation = read("assets/orchestrator-full-delegation.md");
const modes = [
	{ name: "organic", cap: 26_906, route: /fix inline if small and understood, or relaunch with changed scope, hypothesis or handoff plus new evidence/ },
	{ name: "full-delegation", cap: 30_400, route: /never edit: launch a new bounded writer with the diagnosis, new evidence and changed scope or hypothesis/ },
] as const;

// Probe what the parent receives, not a model's adherence to the instructions.
function recovery(mode: (typeof modes)[number]["name"]): string {
	const prompt = __testing.buildGentlePrompt("gentleman", scratch, ["read", "bash", "edit", "write", "subagent_run"], undefined, "tui", mode);
	const line = prompt.split("\n").find((entry) => entry.startsWith("Worker exhaustion:"));
	assert.ok(line, `${mode} must receive the recovery paragraph`);
	return line;
}

for (const mode of modes) {
	test(`S11 ${mode.name}: the parent keeps the worker on evidence-based corrections`, () => {
		assert.match(recovery(mode.name), /Keep the worker correcting while attempts name the cause from output and change the fix to address it/);
	});

	test(`S11 ${mode.name}: even a first boundary failure hands off to authorized recovery`, () => {
		const line = recovery(mode.name);
		assert.match(line, /after a real fix without a new hypothesis ends the worker's cycle, not the unit/);
		assert.match(line, /Even a first failure yields `partial` if passing requires weakening, skipping or rewriting the check, or the fix exceeds allowed surfaces or an explicit limit/);
		const handoff = line.slice(line.indexOf("On any partial,"));
		assert.match(handoff, /On any partial, diagnose from evidence; confirm no child is active or uncertain\. Within user-authorized scope:/);
		assert.match(handoff, mode.route);
		assert.match(handoff, /No permitted route: report only that work incomplete; continue independent work/);
		assert.match(line, /The parent owns the next step, unasked, within native authority/);
		assert.match(line, /Never repeat an attempt or swap executors to dodge limits/);
	});

	test(`S6 ${mode.name}: aggregate affected instructions fit the baseline`, (t) => {
		const components = {
			worker: bytes(worker.instructions), verification: bytes(verification), quota: bytes(quota),
			recovery: bytes(recovery(mode.name)), mode: mode.name === "full-delegation" ? bytes(fullDelegation) : 0,
		};
		const total = Object.values(components).reduce((sum, size) => sum + size, 0);
		t.diagnostic(`${total} B = ${JSON.stringify(components)}`);
		assert.ok(total <= mode.cap, `${mode.name} affected instructions: ${total} B > ${mode.cap} B`);
	});
}

test("S11: auxiliary verifier tooling has its own correction bound, not a writer counter or a setup retry", () => {
	const docs = read("docs/delegated-verification.md");
	for (const text of [verification, docs]) {
		assert.match(text, /Auxiliary verifier tooling defects have a separate correction bound: one fix per failing check, a second only if it still fails after a real fix\. If still failing, report `status: partial` with command and output\. Setup failure never resets it\./);
	}
	assert.match(verification, /one correction in the same verification.*never repair helpers more or auto-relaunch/);
	assert.doesNotMatch(worker.instructions, /one correction (?:attempt )?per failing check/);
});
