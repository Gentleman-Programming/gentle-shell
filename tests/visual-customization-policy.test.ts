import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_VISUAL_SETTINGS, DENSITY, HEADER_PLACEMENT, parseVisualSettingsFile, resolveVisualSettings, STATUS_PLACEMENT, writeVisualSettings, VISUAL_SCHEMA } from "../lib/visual-customization-policy.ts";

test("missing settings use responsive defaults and return independent copies", () => {
	const home = mkdtempSync(join(tmpdir(), "visual-policy-"));
	try {
		const resolved = resolveVisualSettings({ gentlePiConfigHome: home });
		assert.deepEqual(resolved.settings, DEFAULT_VISUAL_SETTINGS);
		assert.equal(DEFAULT_VISUAL_SETTINGS.statusPlacement, "auto");
		assert.equal(DEFAULT_VISUAL_SETTINGS.headerPlacement, "top");
		assert.equal(DEFAULT_VISUAL_SETTINGS.density, "comfortable");
		assert.deepEqual(DEFAULT_VISUAL_SETTINGS.visibility, { changes: true, agents: true, todo: true, usageCost: true, modelDetails: true });
		resolved.settings.visibility.agents = false;
		assert.equal(DEFAULT_VISUAL_SETTINGS.visibility.agents, true);
		assert.equal(resolveVisualSettings({ gentlePiConfigHome: home }).settings.visibility.agents, true);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("strict versioned parsing rejects malformed and partial settings", () => {
	const valid = { schema: VISUAL_SCHEMA, ...DEFAULT_VISUAL_SETTINGS };
	assert.deepEqual(parseVisualSettingsFile(JSON.stringify(valid)), DEFAULT_VISUAL_SETTINGS);
	for (const value of ["{", "null", "[]", JSON.stringify({ ...valid, schema: "future" }), JSON.stringify({ ...valid, density: "dense" }), JSON.stringify({ ...valid, visibility: { ...valid.visibility, todo: "yes" } }), JSON.stringify({ ...valid, extra: 1 }), JSON.stringify({ ...valid, visibility: { changes: true } })]) {
		assert.equal(parseVisualSettingsFile(value), undefined);
	}
});

test("an unreadable settings path is a read error, not malformed content", () => {
	const home = mkdtempSync(join(tmpdir(), "visual-policy-"));
	try {
		mkdirSync(join(home, "visual-customization.json"));
		const result = resolveVisualSettings({ gentlePiConfigHome: home });
		assert.equal(result.malformed, false);
		assert.equal(result.readError, true);
		assert.equal(result.source, "global_file");
		assert.deepEqual(result.settings, DEFAULT_VISUAL_SETTINGS);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("failed rename preserves the destination and removes the temporary file", () => {
	const home = mkdtempSync(join(tmpdir(), "visual-policy-"));
	try {
		const destination = join(home, "visual-customization.json");
		mkdirSync(destination);
		assert.throws(() => writeVisualSettings(DEFAULT_VISUAL_SETTINGS, { gentlePiConfigHome: home }));
		assert.deepEqual(readdirSync(home), ["visual-customization.json"]);
		assert.equal(statSync(destination).isDirectory(), true);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("each placement and density value survives a versioned write and read", () => {
	const home = mkdtempSync(join(tmpdir(), "visual-policy-"));
	try {
		for (const statusPlacement of Object.values(STATUS_PLACEMENT)) {
			for (const headerPlacement of Object.values(HEADER_PLACEMENT)) {
				for (const density of Object.values(DENSITY)) {
					const settings = { ...DEFAULT_VISUAL_SETTINGS, statusPlacement, headerPlacement, density };
					writeVisualSettings(settings, { gentlePiConfigHome: home });
					assert.deepEqual(resolveVisualSettings({ gentlePiConfigHome: home }).settings, settings);
				}
			}
		}
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("atomic write round trips and invalid existing files fall back without overwriting", () => {
	const home = mkdtempSync(join(tmpdir(), "visual-policy-"));
	try {
		const settings = { ...DEFAULT_VISUAL_SETTINGS, statusPlacement: "hidden" as const, headerPlacement: "below-input" as const, density: "minimal" as const, visibility: { ...DEFAULT_VISUAL_SETTINGS.visibility, agents: false } };
		const path = writeVisualSettings(settings, { gentlePiConfigHome: home });
		assert.equal(path, join(home, "visual-customization.json"));
		if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.deepEqual(resolveVisualSettings({ gentlePiConfigHome: home }).settings, settings);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schema: VISUAL_SCHEMA, ...settings });
		const validFile = readFileSync(path, "utf8");
		assert.throws(() => writeVisualSettings({ ...settings, density: "bad" as typeof settings.density }, { gentlePiConfigHome: home }));
		assert.equal(readFileSync(path, "utf8"), validFile);
		writeFileSync(path, "broken");
		assert.deepEqual(resolveVisualSettings({ gentlePiConfigHome: home }).settings, DEFAULT_VISUAL_SETTINGS);
		assert.equal(resolveVisualSettings({ gentlePiConfigHome: home }).malformed, true);
		assert.equal(readFileSync(path, "utf8"), "broken");
	} finally { rmSync(home, { recursive: true, force: true }); }
});
