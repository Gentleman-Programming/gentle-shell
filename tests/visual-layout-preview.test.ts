import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { layoutSchematic } from "../lib/visual-layout-preview.ts";
import { applyVisualPreset, DEFAULT_VISUAL_SETTINGS, VISUAL_PRESET } from "../lib/visual-customization-policy.ts";

test("the layout schematic draws where the header, Status and sections go", () => {
	const neutral = layoutSchematic(DEFAULT_VISUAL_SETTINGS).split("\n");
	assert.equal(neutral.length, 4);
	for (const line of neutral) assert.equal(visibleWidth(line), visibleWidth(neutral[0]!), "a closed box");
	assert.match(neutral[0]!, /^┌─ header ─+┐$/, "the top header spans the conversation and rail");
	assert.doesNotMatch(neutral[0]!, /┬|Status/);
	assert.match(neutral.join("\n"), /todos/);
	assert.doesNotMatch(neutral.join("\n"), /stats/);
	assert.match(neutral[3]!, /bar under 140 cols/, "auto explains its fallback");

	const power = layoutSchematic(applyVisualPreset(DEFAULT_VISUAL_SETTINGS, VISUAL_PRESET.POWER_USER)).split("\n");
	assert.match(power.join("\n"), /stats/, "Power user shows its Stats section");

	const light = layoutSchematic(applyVisualPreset(DEFAULT_VISUAL_SETTINGS, VISUAL_PRESET.LIGHT)).split("\n");
	assert.doesNotMatch(light.join("\n"), /Status ─|todos/, "Light has no rail");
	assert.match(light[3]!, /status bar/);

	const belowRail = layoutSchematic({ ...DEFAULT_VISUAL_SETTINGS, headerPlacement: "below-input" }).split("\n");
	assert.match(belowRail[0]!, /┬─ Status/);
	assert.match(belowRail[3]!, /^└─ status bar ─+┘$/, "the bottom bar spans both columns");
	for (const line of belowRail) assert.equal(visibleWidth(line), visibleWidth(belowRail[0]!));

	const below = layoutSchematic({ ...DEFAULT_VISUAL_SETTINGS, headerPlacement: "below-input", statusPlacement: "hidden" }).split("\n");
	assert.doesNotMatch(below[0]!, /header/);
	assert.match(below.join("\n"), /› input · header/);
	assert.doesNotMatch(below.join("\n"), /Status|status bar/, "hidden shows no Status at all");
	for (const line of below) assert.equal(visibleWidth(line), visibleWidth(below[0]!));
});

test("the layout schematic draws a split header as a title row over the rail and a status bar under it", () => {
	const split = layoutSchematic({ ...DEFAULT_VISUAL_SETTINGS, headerPlacement: "split" }).split("\n");
	assert.match(split[0]!, /^┌─ title ─+┐$/, "the title row spans the rail");
	assert.match(split[split.length - 1]!, /status bar/);
	assert.match(split.join("\n"), /todos/, "the rail sections stay");
	for (const line of split) assert.equal(visibleWidth(line), visibleWidth(split[0]!), "a closed box");
});
