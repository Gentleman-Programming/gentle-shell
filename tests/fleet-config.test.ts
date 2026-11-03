import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_MAX_LIVE_MEMBERS, FLEET_CONFIG_FILE, readFleetConfig } from "../lib/fleet-config.ts";

// odd/tasks/fleet-orchestrator.md T4 (S3, L15): the human owns the fleet
// limits in `<gentle-pi config home>/fleet.json`; bad values never crash.

// Scratch stays outside the worktree; it is reported, not removed.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gentle-fleet-config-")));
let counter = 0;

function home(contents?: string): string {
	counter += 1;
	const dir = join(scratch, `home-${counter}`);
	mkdirSync(dir, { recursive: true });
	if (contents !== undefined) writeFileSync(join(dir, FLEET_CONFIG_FILE), contents);
	return dir;
}

test("a missing fleet.json gives the defaults: 8 live members and no budgets", () => {
	const dir = home();
	assert.equal(DEFAULT_MAX_LIVE_MEMBERS, 8);
	assert.deepEqual(readFleetConfig(dir), { path: join(dir, "fleet.json"), maxLiveMembers: 8, fleetBudgetUsd: undefined, memberBudgetUsd: undefined, ignored: [] });
	assert.deepEqual(readdirSync(dir), [], "reading never creates the file");
});

test("fleet.json sets the live-member limit and both budgets", () => {
	const dir = home(JSON.stringify({ maxLiveMembers: 20, fleetBudgetUsd: 12.5, memberBudgetUsd: 2, unknown: true }));
	assert.deepEqual(readFleetConfig(dir), { path: join(dir, "fleet.json"), maxLiveMembers: 20, fleetBudgetUsd: 12.5, memberBudgetUsd: 2, ignored: [] });
	assert.equal(readFleetConfig(home(JSON.stringify({ maxLiveMembers: 1 }))).maxLiveMembers, 1, "one is the smallest limit");
});

test("invalid values fall back to their defaults and are reported, never thrown", () => {
	for (const value of [0, -3, 2.5, "4", null, Number.MAX_SAFE_INTEGER + 2]) {
		const config = readFleetConfig(home(JSON.stringify({ maxLiveMembers: value, fleetBudgetUsd: 3 })));
		assert.equal(config.maxLiveMembers, 8, JSON.stringify(value));
		assert.equal(config.fleetBudgetUsd, 3, "valid fields are kept");
		assert.deepEqual(config.ignored, ["maxLiveMembers (an integer of at least 1)"], JSON.stringify(value));
	}
	const budgets = readFleetConfig(home(JSON.stringify({ fleetBudgetUsd: 0, memberBudgetUsd: "1" })));
	assert.deepEqual([budgets.fleetBudgetUsd, budgets.memberBudgetUsd], [undefined, undefined]);
	assert.deepEqual(budgets.ignored, ["fleetBudgetUsd (a number of USD above 0)", "memberBudgetUsd (a number of USD above 0)"]);
});

test("a malformed or unreadable fleet.json reads as the defaults", () => {
	for (const contents of ["{not json", "[8]", "8", "null"]) {
		const config = readFleetConfig(home(contents));
		assert.deepEqual([config.maxLiveMembers, config.fleetBudgetUsd, config.memberBudgetUsd], [8, undefined, undefined], contents);
		assert.deepEqual(config.ignored, ["the whole file (a JSON object)"], contents);
	}
	const dir = home();
	mkdirSync(join(dir, FLEET_CONFIG_FILE));
	const unreadable = readFleetConfig(dir);
	assert.equal(unreadable.maxLiveMembers, 8);
	assert.deepEqual(unreadable.ignored, ["the whole file (a JSON object)"]);
});
