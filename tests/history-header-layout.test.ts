import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planHeaderLayout,
  SCOPE_RADIO_COMPACT_GLOBAL,
  SCOPE_RADIO_COMPACT_PROJECT,
  SCOPE_RADIO_FULL_GLOBAL,
  SCOPE_RADIO_FULL_PROJECT,
  scopeRadioText,
} from "../extensions/history/selector-helpers.ts";

const LEFT =
  " History Search ".length +
  " · 1 of 10 ".length +
  " · loaded 10 of 27 ".length;
const RADIO = SCOPE_RADIO_FULL_PROJECT.length;
const GAP = 4;

test("inline while counts plus radio plus minimum gap fit the width", () => {
  assert.equal(
    planHeaderLayout(LEFT + GAP + RADIO, LEFT, RADIO, GAP),
    "inline",
  );
  assert.equal(planHeaderLayout(200, LEFT, RADIO, GAP), "inline");
});

test("stacked (tablet) once the spacer would drop below the minimum gap", () => {
  assert.equal(
    planHeaderLayout(LEFT + GAP + RADIO - 1, LEFT, RADIO, GAP),
    "stacked",
  );
  assert.equal(planHeaderLayout(LEFT, LEFT, RADIO, GAP), "stacked");
});

test("compact (mobile) when even the counts line no longer fits", () => {
  assert.equal(planHeaderLayout(LEFT - 1, LEFT, RADIO, GAP), "compact");
  assert.equal(planHeaderLayout(30, LEFT, RADIO, GAP), "compact");
});

test("radio pins the user-directed labels", () => {
  assert.equal(SCOPE_RADIO_FULL_PROJECT, "◉ Current project | ○ All projects");
  assert.equal(SCOPE_RADIO_FULL_GLOBAL, "○ Current project | ◉ All projects");
  assert.equal(SCOPE_RADIO_COMPACT_PROJECT, "◉ Current project | ○ All");
  assert.equal(SCOPE_RADIO_COMPACT_GLOBAL, "○ Current | ◉ All projects");
});

test("scopeRadioText abbreviates only in compact mode", () => {
  assert.equal(scopeRadioText("project", false), SCOPE_RADIO_FULL_PROJECT);
  assert.equal(scopeRadioText("global", false), SCOPE_RADIO_FULL_GLOBAL);
  assert.equal(scopeRadioText("project", true), SCOPE_RADIO_COMPACT_PROJECT);
  assert.equal(scopeRadioText("global", true), SCOPE_RADIO_COMPACT_GLOBAL);
});
