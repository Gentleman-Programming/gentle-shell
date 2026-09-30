import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_VISUAL_SETTINGS } from "../lib/visual-customization-policy.ts";
import {
	deleteVisualProfile,
	getVisualProfile,
	listVisualProfiles,
	parseVisualProfilesFile,
	readVisualProfiles,
	resetVisualProfiles,
	saveVisualProfile,
	VISUAL_PROFILES_SCHEMA,
} from "../lib/visual-profiles.ts";

const values = {
	themeName: "dark",
	animationPolicy: "quality" as const,
	banner: { showRose: true, showTextLogo: false, color: "pink" as const },
	visual: structuredClone(DEFAULT_VISUAL_SETTINGS),
};

test("named profiles require explicit replacement and catalog reset leaves other settings untouched", () => {
	const home = { gentlePiConfigHome: mkdtempSync(join(tmpdir(), "visual-profiles-test-")) };
	saveVisualProfile("work", values, home);
	assert.deepEqual(listVisualProfiles(home), ["work"]);
	assert.throws(() => saveVisualProfile("work", values, home), /already exists/);
	const saved = getVisualProfile("work", home)!;
	saved.visual.visibility.changes = false;
	assert.equal(getVisualProfile("work", home)!.visual.visibility.changes, true);
	saveVisualProfile("work", { ...values, themeName: "light" }, { ...home, replace: true });
	assert.equal(getVisualProfile("work", home)!.themeName, "light");
	deleteVisualProfile("work", home);
	assert.deepEqual(listVisualProfiles(home), []);
	saveVisualProfile("again", values, home);
	resetVisualProfiles(home);
	assert.deepEqual(listVisualProfiles(home), []);
});

test("malformed and unknown-version catalogs fail closed rather than overwrite", () => {
	const home = { gentlePiConfigHome: mkdtempSync(join(tmpdir(), "visual-profiles-test-")) };
	const path = join(home.gentlePiConfigHome, "visual-profiles.json");
	writeFileSync(path, JSON.stringify({ schema: "future", profiles: [] }));
	assert.equal(readVisualProfiles(home).malformed, true);
	assert.throws(() => saveVisualProfile("new", values, home), /malformed/);
	assert.match(readFileSync(path, "utf8"), /future/);
	assert.equal(parseVisualProfilesFile(JSON.stringify({ schema: VISUAL_PROFILES_SCHEMA, profiles: [{ name: "bad", ...values, unexpected: true }] })), undefined);
	assert.equal(parseVisualProfilesFile(JSON.stringify({ schema: VISUAL_PROFILES_SCHEMA, profiles: [{ name: "a", ...values }, { name: "a", ...values }] })), undefined);
});

test("profiles saved before the rdd section existed load with rdd shown", () => {
	const home = { gentlePiConfigHome: mkdtempSync(join(tmpdir(), "visual-profiles-test-")) };
	const { rdd: _rdd, ...legacyVisibility } = { ...DEFAULT_VISUAL_SETTINGS.visibility, agents: false };
	const legacy = { name: "old", ...values, visual: { ...values.visual, visibility: legacyVisibility } };
	writeFileSync(join(home.gentlePiConfigHome, "visual-profiles.json"), JSON.stringify({ schema: VISUAL_PROFILES_SCHEMA, profiles: [legacy] }));
	const result = readVisualProfiles(home);
	assert.equal(result.malformed, false);
	assert.deepEqual(result.profiles[0]!.visual.visibility, { ...DEFAULT_VISUAL_SETTINGS.visibility, agents: false, rdd: true });
	assert.deepEqual(getVisualProfile("old", home)!.visual.visibility.rdd, true);
	const unknown = { ...legacy, visual: { ...legacy.visual, visibility: { ...legacyVisibility, extra: true } } };
	assert.equal(parseVisualProfilesFile(JSON.stringify({ schema: VISUAL_PROFILES_SCHEMA, profiles: [unknown] })), undefined);
});

test("symlinked catalog file is rejected instead of followed, and save/delete leave the symlink target untouched", (t) => {
	const home = mkdtempSync(join(tmpdir(), "visual-profiles-test-"));
	const target = join(home, "target.json");
	const targetContent = JSON.stringify({ schema: VISUAL_PROFILES_SCHEMA, profiles: [] });
	writeFileSync(target, targetContent);
	try {
		symlinkSync(target, join(home, "visual-profiles.json"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
			t.skip(`symlink creation unavailable in this environment: ${code}`);
			return;
		}
		throw error;
	}
	const result = readVisualProfiles({ gentlePiConfigHome: home });
	assert.equal(result.profiles.length, 0);
	assert.ok(result.readError || result.malformed, "symlinked catalog must not be silently followed and accepted");
	assert.throws(() => saveVisualProfile("x", values, { gentlePiConfigHome: home }));
	assert.throws(() => deleteVisualProfile("x", { gentlePiConfigHome: home }));
	assert.equal(readFileSync(target, "utf8"), targetContent);
});
