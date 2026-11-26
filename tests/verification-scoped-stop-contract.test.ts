import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verifierSettleReminderText } from "../lib/verifier-settle-reminder.ts";

// harness-continuity T6 (S3/S6): a verification stop is scoped to the unit it verifies. It reports the
// open blockers or missing proof as partial, keeps every budget separate and unreset, and never revives the
// retired generic terminal phrase. Instruction-delivery contract only, not proof of model adherence.
const verification = readFileSync(new URL("../assets/orchestrator-verification.md", import.meta.url), "utf8");
const lineStarting = (start: string) => verification.split("\n").find((line) => line.startsWith(start)) ?? "";

test("S3/S6: verification stops are scoped partial reports, never the generic terminal phrase", () => {
	assert.ok(!verification.includes("Needs your decision"), "the verification module must not keep the retired terminal phrase");
	const setup = lineStarting("A failed verifier setup");
	assert.match(setup, /If setup still fails or lacks prerequisites, stop verifying/);
	assert.match(setup, /exact unrun checks as unverified/);
	assert.match(setup, /never repair helpers more or auto-relaunch for it/);
	const correction = lineStarting("5. **One correction**");
	assert.match(correction, /Blockers still open after that leave the unit `status: partial`, naming any genuine human decision/);
	assert.match(correction, /independent authorized work continues/);
	assert.match(correction, /A second correction runs automatically only when the recheck shows the same blocker still failing; a new finding never earns one/);
});

test("S6: worker, setup, recheck, native, and user budgets stay separate and changed state never resets them", () => {
	assert.match(verification, /Worker progress is separate from explicit setup, recheck, native and user limits; changed state earns a fresh check, not a reset\./);
});

test("S3/S6: the settle reminder asks for the verifier or an honest missing-proof report", () => {
	const text = verifierSettleReminderText(3);
	assert.ok(!text.includes("Needs your decision"), "the reminder must not revive the retired terminal phrase");
	assert.match(text, /If verification is unavailable, report the missing proof and do not claim the change complete\./);
});
