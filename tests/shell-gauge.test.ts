import assert from "node:assert/strict";
import test from "node:test";
import { paintGauge, renderGauge, type GaugePaint } from "../lib/shell-gauge.ts";

// Issue #2222: gauge-specific theme roles fall back to today's roles when a
// theme does not define them, so existing themes render byte-identically.
// (Fixtures here are unit-scoped stubs; Pi's theme schema is validated
// separately by the loader and was checked directly against ThemeJsonSchema.)

const taggedTheme = {
	fg(color: string, text: string) {
		return `<${color}>${text}</${color}>`;
	},
};

test("paintGauge falls back to today's roles when no gauge roles are given", () => {
	assert.equal(paintGauge(45, taggedTheme), `<accent>▰▰▰▰</accent><border>▱▱▱▱</border>`);
	assert.equal(paintGauge(85, taggedTheme), `<warning>▰▰▰▰▰▰▰</warning><border>▱</border>`);
	assert.equal(paintGauge(96, taggedTheme), `<error>▰▰▰▰▰▰▰▰</error><border></border>`);
	assert.equal(paintGauge(null, taggedTheme), `<dim></dim><border>▱▱▱▱▱▱▱▱</border>`);
});

test("paintGauge uses the gauge-specific roles when the theme defines them", () => {
	const roles: GaugePaint = { ok: "gaugeOk", warning: "gaugeWarning", error: "gaugeError", empty: "gaugeEmpty" };
	assert.equal(paintGauge(45, taggedTheme, 8, roles), `<gaugeOk>▰▰▰▰</gaugeOk><gaugeEmpty>▱▱▱▱</gaugeEmpty>`);
	assert.equal(paintGauge(85, taggedTheme, 8, roles), `<gaugeWarning>▰▰▰▰▰▰▰</gaugeWarning><gaugeEmpty>▱</gaugeEmpty>`);
	assert.equal(paintGauge(96, taggedTheme, 8, roles), `<gaugeError>▰▰▰▰▰▰▰▰</gaugeError><gaugeEmpty></gaugeEmpty>`);
	// A null percentage stays dim: there is nothing to gauge yet.
	assert.equal(paintGauge(null, taggedTheme, 8, roles), `<dim></dim><gaugeEmpty>▱▱▱▱▱▱▱▱</gaugeEmpty>`);
});

test("paintGauge falls back per role, not per block", () => {
	// A theme that defines only gaugeWarning keeps accent for the ok range.
	assert.equal(paintGauge(45, taggedTheme, 8, { warning: "gaugeWarning" }), `<accent>▰▰▰▰</accent><border>▱▱▱▱</border>`);
	assert.equal(paintGauge(85, taggedTheme, 8, { warning: "gaugeWarning" }), `<gaugeWarning>▰▰▰▰▰▰▰</gaugeWarning><border>▱</border>`);
});

test("renderGauge uses theme-defined glyphs when given, defaults otherwise", () => {
	assert.equal(renderGauge(50, 4, { filled: "█", empty: "░" }), "██░░");
	assert.equal(renderGauge(50, 4), "▰▰▱▱");
	assert.equal(renderGauge(50, 4, { filled: "█" }), "██▱▱");
});
