import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_VISUAL_SETTINGS, DENSITY, HEADER_PLACEMENT, parseVisualSettingsFile, resolveVisualSettings, STATUS_PLACEMENT, VISUAL_SECTION_KEYS, writeVisualSettings, VISUAL_SCHEMA } from "../lib/visual-customization-policy.ts";

test("MCP is opt-in for new and existing preferences and persists both choices", () => {
	assert.equal(DEFAULT_VISUAL_SETTINGS.visibility.mcp, false);
	assert.ok(VISUAL_SECTION_KEYS.includes("mcp"));
	const { mcp: _mcp, ...legacyVisibility } = DEFAULT_VISUAL_SETTINGS.visibility;
	const legacy = { schema: VISUAL_SCHEMA, ...DEFAULT_VISUAL_SETTINGS, visibility: { ...legacyVisibility, todo: false } };
	assert.deepEqual(parseVisualSettingsFile(JSON.stringify(legacy))?.visibility, { ...legacyVisibility, todo: false, mcp: false });
	assert.equal(parseVisualSettingsFile(JSON.stringify({ ...legacy, visibility: { ...legacyVisibility, mcp: null } })), undefined);
	const home = mkdtempSync(join(tmpdir(), "visual-mcp-"));
	try {
		for (const mcp of [true, false]) {
			const settings = { ...DEFAULT_VISUAL_SETTINGS, visibility: { ...DEFAULT_VISUAL_SETTINGS.visibility, mcp } };
			writeVisualSettings(settings, { gentlePiConfigHome: home });
			assert.deepEqual(resolveVisualSettings({ gentlePiConfigHome: home }).settings, settings);
		}
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("missing settings use responsive defaults and return independent copies", () => {
	const home = mkdtempSync(join(tmpdir(), "visual-policy-"));
	try {
		const resolved = resolveVisualSettings({ gentlePiConfigHome: home });
		assert.deepEqual(resolved.settings, DEFAULT_VISUAL_SETTINGS);
		assert.equal(DEFAULT_VISUAL_SETTINGS.statusPlacement, "auto");
		assert.equal(DEFAULT_VISUAL_SETTINGS.headerPlacement, "top");
		assert.equal(DEFAULT_VISUAL_SETTINGS.density, "comfortable");
		assert.deepEqual(DEFAULT_VISUAL_SETTINGS.visibility, { changes: true, rdd: true, agents: true, todo: true, mcp: false, usageCost: true, modelDetails: true, contextWarning: true });
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

test("Sections rows follow one ordered key list that covers every visibility key", () => {
	assert.deepEqual(VISUAL_SECTION_KEYS, ["changes", "rdd", "agents", "todo", "mcp", "usageCost", "modelDetails", "contextWarning"]);
	assert.deepEqual([...VISUAL_SECTION_KEYS].sort(), Object.keys(DEFAULT_VISUAL_SETTINGS.visibility).sort());
});

test("settings saved before the rdd section existed load as valid with rdd shown", () => {
	const legacy = { schema: VISUAL_SCHEMA, ...DEFAULT_VISUAL_SETTINGS, visibility: { changes: false, agents: true, todo: false, usageCost: true, modelDetails: false } };
	const expected = { ...DEFAULT_VISUAL_SETTINGS, visibility: { changes: false, rdd: true, agents: true, todo: false, mcp: false, usageCost: true, modelDetails: false, contextWarning: true } };
	assert.deepEqual(parseVisualSettingsFile(JSON.stringify(legacy)), expected);
	assert.deepEqual(parseVisualSettingsFile(JSON.stringify({ ...legacy, visibility: { ...expected.visibility, rdd: false } })), { ...expected, visibility: { ...expected.visibility, rdd: false } });
	for (const visibility of [{ ...legacy.visibility, extra: true }, { ...legacy.visibility, rdd: "no" }, { ...legacy.visibility, todo: "yes" }, { agents: true, todo: true, usageCost: true, modelDetails: true, rdd: true }]) {
		assert.equal(parseVisualSettingsFile(JSON.stringify({ ...legacy, visibility })), undefined);
	}
	const home = mkdtempSync(join(tmpdir(), "visual-policy-"));
	try {
		writeFileSync(join(home, "visual-customization.json"), JSON.stringify(legacy));
		const resolved = resolveVisualSettings({ gentlePiConfigHome: home });
		assert.equal(resolved.malformed, false);
		assert.deepEqual(resolved.settings, expected);
		const { rdd: _rdd, ...legacyVisibility } = expected.visibility;
		assert.throws(() => writeVisualSettings({ ...expected, visibility: legacyVisibility } as typeof expected), /Invalid visual settings/);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("settings saved before contextWarning existed load it shown and preserve rdd", () => {
	// Both historical shapes: the earliest pre-rdd visibility and the previous-current shape that
	// already had rdd but not contextWarning. Only the missing added keys default to shown.
	const shared = { schema: VISUAL_SCHEMA, ...DEFAULT_VISUAL_SETTINGS };
	const preRdd = { ...shared, visibility: { changes: false, agents: true, todo: false, usageCost: true, modelDetails: false } };
	assert.deepEqual(parseVisualSettingsFile(JSON.stringify(preRdd)), { ...DEFAULT_VISUAL_SETTINGS,
		visibility: { changes: false, rdd: true, agents: true, todo: false, mcp: false, usageCost: true, modelDetails: false, contextWarning: true } });
	const preContext = { ...shared, visibility: { changes: false, rdd: false, agents: true, todo: false, usageCost: true, modelDetails: false } };
	assert.deepEqual(parseVisualSettingsFile(JSON.stringify(preContext)), { ...DEFAULT_VISUAL_SETTINGS,
		visibility: { changes: false, rdd: false, agents: true, todo: false, mcp: false, usageCost: true, modelDetails: false, contextWarning: true } });
	const withoutRdd = { ...shared, visibility: { changes: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: false } };
	assert.deepEqual(parseVisualSettingsFile(JSON.stringify(withoutRdd)), { ...DEFAULT_VISUAL_SETTINGS,
		visibility: { changes: true, rdd: true, agents: true, todo: true, mcp: false, usageCost: true, modelDetails: true, contextWarning: false } });
});

test("a present non-boolean added key in a partial legacy shape is rejected before default fill", () => {
	// Missing added keys default to shown, but a key that is present must already be a
	// boolean: `null` (or any other value) must not be silently coerced by the fill.
	const base = { changes: true, agents: true, todo: true, usageCost: true, modelDetails: true };
	for (const visibility of [{ ...base, rdd: null }, { ...base, contextWarning: null }]) {
		assert.equal(parseVisualSettingsFile(JSON.stringify({ schema: VISUAL_SCHEMA, ...DEFAULT_VISUAL_SETTINGS, visibility })), undefined,
			`${JSON.stringify(visibility)} must stay invalid`);
	}
	const previousCurrent = structuredClone(DEFAULT_VISUAL_SETTINGS) as unknown as { visibility: Record<string, unknown> };
	delete previousCurrent.visibility.contextWarning;
	previousCurrent.visibility.rdd = null;
	assert.equal(parseVisualSettingsFile(JSON.stringify({ schema: VISUAL_SCHEMA, ...previousCurrent })), undefined);
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
