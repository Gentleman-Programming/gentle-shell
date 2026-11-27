import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILE_CARD_SCHEMA, PROFILE_CARD_SETTINGS_CHANGED, resolveProfileCard, writeProfileCard } from "../lib/profile-card-policy.ts";

function scratch(t: test.TestContext): string {
	const home = mkdtempSync(join(tmpdir(), "profile-card-policy-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return home;
}

test("the card is hidden by default when the file is missing", (t) => {
	const home = scratch(t);
	const resolved = resolveProfileCard({ gentlePiConfigHome: home });
	assert.equal(resolved.visible, false);
	assert.equal(resolved.source, "default");
	assert.equal(resolved.globalFile, join(home, "profile-card.json"));
});

test("invalid JSON, wrong schema and wrong shapes read as hidden without throwing", (t) => {
	const home = scratch(t);
	const file = join(home, "profile-card.json");
	for (const raw of [
		"{not json",
		"",
		"[]",
		JSON.stringify({ schema: "other/v1", visible: true }),
		JSON.stringify({ schema: PROFILE_CARD_SCHEMA, visible: "yes" }),
		JSON.stringify({ schema: PROFILE_CARD_SCHEMA }),
	]) {
		writeFileSync(file, raw);
		const resolved = resolveProfileCard({ gentlePiConfigHome: home });
		assert.equal(resolved.visible, false, raw);
		assert.equal(resolved.malformed, true, raw);
	}
});

test("write then resolve round-trips on and off, with the documented file shape", (t) => {
	const home = scratch(t);
	const file = writeProfileCard(true, { gentlePiConfigHome: home });
	assert.equal(file, join(home, "profile-card.json"));
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { schema: "gentle-pi.profile-card/v1", visible: true });
	assert.equal(resolveProfileCard({ gentlePiConfigHome: home }).visible, true);
	assert.equal(resolveProfileCard({ gentlePiConfigHome: home }).source, "global_file");
	writeProfileCard(false, { gentlePiConfigHome: home });
	assert.equal(resolveProfileCard({ gentlePiConfigHome: home }).visible, false);
	assert.deepEqual(readdirSync(home), ["profile-card.json"]);
});

test("writing replaces a malformed file and rejects non-boolean input without touching disk", (t) => {
	const home = scratch(t);
	writeFileSync(join(home, "profile-card.json"), "garbage");
	writeProfileCard(true, { gentlePiConfigHome: home });
	assert.equal(resolveProfileCard({ gentlePiConfigHome: home }).visible, true);
	assert.throws(() => writeProfileCard("on" as unknown as boolean, { gentlePiConfigHome: home }), TypeError);
	assert.equal(resolveProfileCard({ gentlePiConfigHome: home }).visible, true);
});

test("the change channel and schema are stable names", () => {
	assert.equal(PROFILE_CARD_SCHEMA, "gentle-pi.profile-card/v1");
	assert.equal(typeof PROFILE_CARD_SETTINGS_CHANGED, "string");
	assert.ok(PROFILE_CARD_SETTINGS_CHANGED.length > 0);
	assert.equal(existsSync(join(tmpdir(), "profile-card.json")), false);
});
