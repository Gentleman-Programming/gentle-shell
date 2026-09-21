import { test } from "node:test";
import assert from "node:assert/strict";
import {
  editorOverlayMargin,
  SIDEBAR_OVERLAY_PADDING,
  SIDEBAR_RAIL_OVERLAY_MARGIN,
} from "../extensions/history/selector-helpers.ts";

function terminalWithState(state: unknown): object {
  return {
    [Symbol.for("gentle-pi.experimental-sidebar.state")]: state,
  } as object;
}

test("margin constant pins the gentle-shell rail geometry (RAIL_WIDTH 50 + GAP 3)", () => {
  assert.equal(SIDEBAR_RAIL_OVERLAY_MARGIN, 53);
});

test("padding constant pins the user-directed 1-column breathing room", () => {
  assert.equal(SIDEBAR_OVERLAY_PADDING, 1);
});

test("returns 0 for absent, primitive, or null terminals", () => {
  assert.equal(editorOverlayMargin(undefined), 0);
  assert.equal(editorOverlayMargin(null), 0);
  assert.equal(editorOverlayMargin(42), 0);
  assert.equal(editorOverlayMargin("terminal"), 0);
});

test("returns 0 when no sidebar state is stored on the terminal", () => {
  assert.equal(editorOverlayMargin({}), 0);
});

test("returns 0 for malformed state shapes", () => {
  assert.equal(editorOverlayMargin(terminalWithState(undefined)), 0);
  assert.equal(editorOverlayMargin(terminalWithState(null)), 0);
  assert.equal(editorOverlayMargin(terminalWithState("active")), 0);
});

test("returns 0 unless active is exactly true AND ownsHost is a function", () => {
  assert.equal(
    editorOverlayMargin(terminalWithState({ active: true })),
    0,
    "active without ownsHost",
  );
  assert.equal(
    editorOverlayMargin(
      terminalWithState({ active: false, ownsHost: () => true }),
    ),
    0,
    "inactive",
  );
  assert.equal(
    editorOverlayMargin(terminalWithState({ active: 1, ownsHost: () => true })),
    0,
    "non-boolean truthy active",
  );
  assert.equal(
    editorOverlayMargin(
      terminalWithState({ active: true, ownsHost: "not-a-function" }),
    ),
    0,
    "non-function ownsHost",
  );
});

test("returns the geometry margin plus padding only while the sidebar owns the host", () => {
  assert.equal(
    editorOverlayMargin(
      terminalWithState({ active: true, ownsHost: () => true }),
    ),
    54,
  );
  assert.equal(
    editorOverlayMargin(
      terminalWithState({ active: true, ownsHost: () => false }),
    ),
    0,
    "state present but host not owned (regular mode / unpatched root)",
  );
});

test("a throwing ownsHost degrades to 0 instead of breaking the picker", () => {
  assert.equal(
    editorOverlayMargin(
      terminalWithState({
        active: true,
        ownsHost: () => {
          throw new Error("boom");
        },
      }),
    ),
    0,
  );
});
