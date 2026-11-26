import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const TECHNICAL_REFERENCE = readFileSync("docs/readme-reference.md", "utf8");
const CONTROLLER = readFileSync("extensions/gentle-ai.ts", "utf8");

test("technical reference documents the narrow published native maintenance contract", () => {
	assert.match(TECHNICAL_REFERENCE, /`gentle_review abandon` remains an explicit maintenance route/i);
	assert.match(TECHNICAL_REFERENCE, /fresh interactive approval/i);
	assert.match(TECHNICAL_REFERENCE, /review dispose-result.*unsupported.*pending.*design/i);
	assert.match(TECHNICAL_REFERENCE, /RESET.*RECOVER.*destructive/i);
	assert.match(TECHNICAL_REFERENCE, /native-input-required/);
	for (const removed of ["quarantine-legacy", "reconcile-authority", "repair-legacy-alias", "RECOVER_LOCK"]) {
		assert.ok(!TECHNICAL_REFERENCE.includes(removed), `docs must not name removed verb ${removed}`);
	}
});

test("controller help keeps authorization, blocked outcomes, and recovery boundaries explicit", () => {
	assert.match(CONTROLLER, /Use ABANDON only after an explicit user decision/);
	assert.match(CONTROLLER, /provider-selected recovery disposition/);
	assert.match(CONTROLLER, /headlessly|headless/i);
	for (const removed of ["RECOVER_LOCK", "QUARANTINE_LEGACY", "RECONCILE_AUTHORITY", "REPAIR_LEGACY_ALIAS", "quarantine-legacy", "reconcile-authority", "repair-legacy-alias", "recover-lock"]) {
		assert.ok(!CONTROLLER.includes(removed), `controller must not name removed verb ${removed}`);
	}
});
