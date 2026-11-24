import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_TPS_SETTINGS,
	TPS_SETTINGS_SCHEMA,
	isTpsSettings,
	parseTpsSettingsFile,
	resolveTpsSettings,
	writeTpsSettings,
	type Tps,
} from "../lib/tps-policy.ts";

function policyHome(t: test.TestContext): string {
	const home = mkdtempSync(join(tmpdir(), "tps-policy-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return home;
}

test("defaults: TPS enabled", () => {
	assert.equal(DEFAULT_TPS_SETTINGS.enabled, true);
	assert.deepEqual(Object.keys(DEFAULT_TPS_SETTINGS).sort(), ["enabled"]);
});

test("validation accepts only the exact shape with a boolean enabled", () => {
	assert.equal(isTpsSettings({ enabled: true }), true);
	assert.equal(isTpsSettings({ enabled: false }), true);
	assert.equal(isTpsSettings({}), false);
	assert.equal(isTpsSettings({ enabled: "yes" }), false);
	assert.equal(isTpsSettings({ enabled: true, extra: 1 }), false);
	assert.equal(isTpsSettings(null), false);
	assert.equal(isTpsSettings([]), false);
	assert.equal(isTpsSettings("enabled"), false);
});

test("parse accepts the schema wrapper and rejects foreign or malformed payloads", () => {
	assert.deepEqual(parseTpsSettingsFile(`{"schema":"${TPS_SETTINGS_SCHEMA}","enabled":false}`), { enabled: false } satisfies Tps);
	assert.equal(parseTpsSettingsFile('{"schema":"other/v1","enabled":false}'), undefined);
	assert.equal(parseTpsSettingsFile(`{"schema":"${TPS_SETTINGS_SCHEMA}","enabled":"x"}`), undefined);
	assert.equal(parseTpsSettingsFile(`{"schema":"${TPS_SETTINGS_SCHEMA}","enabled":false,"extra":true}`), undefined);
	assert.equal(parseTpsSettingsFile("not json"), undefined);
});

test("resolve: missing file falls back to defaults with clean flags", (t) => {
	const home = policyHome(t);
	const resolution = resolveTpsSettings({ gentlePiConfigHome: home });
	assert.deepEqual(resolution.settings, DEFAULT_TPS_SETTINGS);
	assert.equal(resolution.source, "default");
	assert.equal(resolution.malformed, false);
	assert.equal(resolution.readError, false);
});

test("resolve: malformed file falls back to defaults and reports malformed", (t) => {
	const home = policyHome(t);
	writeFileSync(join(home, "tps.json"), "{oops", "utf8");
	const resolution = resolveTpsSettings({ gentlePiConfigHome: home });
	assert.deepEqual(resolution.settings, DEFAULT_TPS_SETTINGS);
	assert.equal(resolution.malformed, true);
	assert.equal(resolution.source, "global_file");
});

test("resolve: unreadable file reports readError and stays enabled", (t) => {
	const home = policyHome(t);
	mkdirSync(join(home, "tps.json")); // directory where the file should be
	const resolution = resolveTpsSettings({ gentlePiConfigHome: home });
	assert.deepEqual(resolution.settings, DEFAULT_TPS_SETTINGS);
	assert.equal(resolution.readError, true); // EISDIR is not ENOENT: the read really failed
	assert.equal(resolution.malformed, false);
});

test("write then resolve round trip preserves the stored value", (t) => {
	const home = policyHome(t);
	writeTpsSettings({ enabled: false }, { gentlePiConfigHome: home });
	const resolution = resolveTpsSettings({ gentlePiConfigHome: home });
	assert.deepEqual(resolution.settings, { enabled: false } satisfies Tps);
	assert.equal(resolution.source, "global_file");
	assert.equal(resolution.malformed, false);
});

test("write is atomic and owner-only, with the schema wrapping the payload", (t) => {
	const home = policyHome(t);
	writeTpsSettings({ enabled: false }, { gentlePiConfigHome: home });
	const raw = readFileSync(join(home, "tps.json"), "utf8");
	assert.ok(raw.includes(`"schema": "${TPS_SETTINGS_SCHEMA}"`));
	const mode = statSync(join(home, "tps.json")).mode & 0o777;
	assert.equal(mode, 0o600);
});

test("write rejects invalid settings without touching the file", (t) => {
	const home = policyHome(t);
	assert.throws(() => writeTpsSettings({ enabled: "x" as unknown as boolean }, { gentlePiConfigHome: home }));
	assert.throws(() => writeTpsSettings(undefined as unknown as Tps, { gentlePiConfigHome: home }));
	assert.equal(resolveTpsSettings({ gentlePiConfigHome: home }).source, "default");
});
