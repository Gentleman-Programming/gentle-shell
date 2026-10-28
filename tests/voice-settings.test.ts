import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after } from "node:test";
import test from "node:test";
import { readVoicePushToTalk, VOICE_SETTINGS_FILE, VOICE_SETTINGS_SCHEMA, writeVoicePushToTalk } from "../lib/voice-settings.ts";

// The persisted push-to-talk toggle, in a scratch config home inside the
// workspace tmp/ directory.

const scratchRoot = join(import.meta.dirname, "..", "tmp");
mkdirSync(scratchRoot, { recursive: true });
const homes: string[] = [];
const scratchHome = () => {
	const home = mkdtempSync(join(scratchRoot, "voice-ptt-"));
	homes.push(home);
	return home;
};
after(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("push-to-talk is off until written, and a written value survives a fresh read", () => {
	const home = scratchHome();
	const options = { gentlePiConfigHome: home };
	assert.equal(readVoicePushToTalk(options), false);
	const path = writeVoicePushToTalk(true, options);
	assert.equal(path, join(home, VOICE_SETTINGS_FILE));
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schema: VOICE_SETTINGS_SCHEMA, pushToTalk: true });
	// A reload only re-reads the file.
	assert.equal(readVoicePushToTalk({ gentlePiConfigHome: home }), true);
	writeVoicePushToTalk(false, options);
	assert.equal(readVoicePushToTalk(options), false);
});

test("a malformed or foreign settings file reads as off", () => {
	const home = scratchHome();
	const path = join(home, VOICE_SETTINGS_FILE);
	for (const raw of ["not json", "[]", `{"schema":"${VOICE_SETTINGS_SCHEMA}","pushToTalk":"yes"}`, `{"schema":"other","pushToTalk":true}`, `{"schema":"${VOICE_SETTINGS_SCHEMA}","pushToTalk":true,"extra":1}`]) {
		writeFileSync(path, raw);
		assert.equal(readVoicePushToTalk({ gentlePiConfigHome: home }), false, raw);
	}
});

test("the config home follows the environment when no home is given", () => {
	const home = scratchHome();
	writeVoicePushToTalk(true, { gentlePiConfigHome: home });
	assert.equal(readVoicePushToTalk({ env: { GENTLE_PI_CONFIG_HOME: home } }), true);
});
