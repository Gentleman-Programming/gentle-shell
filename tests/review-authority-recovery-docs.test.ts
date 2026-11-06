import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const TECHNICAL_REFERENCE = readFileSync("docs/readme-reference.md", "utf8");
const CONTROLLER = readFileSync("extensions/gentle-ai.ts", "utf8");

test("technical reference documents the narrow published native maintenance contract", () => {
	assert.match(TECHNICAL_REFERENCE, /abandon.*quarantine-legacy.*reconcile-authority.*explicit v2\.1\.11 maintenance/i);
	assert.match(TECHNICAL_REFERENCE, /predecessor lineage and revision.*successor lineage and revision/i);
	assert.match(TECHNICAL_REFERENCE, /exact seven-line.*anomalies=unchanged_target,malformed_recovery_authorization/i);
	assert.match(TECHNICAL_REFERENCE, /fresh interactive approval/i);
	assert.match(TECHNICAL_REFERENCE, /quarantine only the bound invalid compact-v2 recovery successor/i);
	assert.match(TECHNICAL_REFERENCE, /predecessor stays untouched/i);
	assert.match(TECHNICAL_REFERENCE, /repair-legacy-alias.*unsupported historical v1 operation alias/i);
	assert.match(TECHNICAL_REFERENCE, /model supplies only lineage, actor, and reason/i);
	assert.match(TECHNICAL_REFERENCE, /review dispose-result.*unsupported.*pending.*design/i);
	assert.match(TECHNICAL_REFERENCE, /RESET.*RECOVER.*destructive/i);
	assert.match(TECHNICAL_REFERENCE, /typed envelopes/i);
});

test("controller help keeps authorization, blocked outcomes, and recovery boundaries explicit", () => {
	assert.match(CONTROLLER, /REPAIR_LEGACY_ALIAS.*freshly reads native inventory.*interactive approval/is);
	assert.match(CONTROLLER, /unchanged_target,malformed_recovery_authorization/);
	assert.match(CONTROLLER, /provider-selected recovery disposition/);
	assert.match(CONTROLLER, /headlessly|headless/i);
	assert.match(CONTROLLER, /quarantine.*invalid recovery successor/i);
	assert.match(CONTROLLER, /never.*RESET or RECOVER/is);
});
