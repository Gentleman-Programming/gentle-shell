import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Unit 4 — L6 wheel slice (spec C5, design §D6).
//
// Source-parse structural pins on extensions/history/index.ts (no pi-tui
// runtime graph — the same discipline as the other source-parse suites).
// The overlay renders only through pi-tui, so the unit-level contract is the
// SHAPE of the handleMouse override:
//
// - wheel-only: every non-wheel event type returns undefined (press/click/
//   drag stay host-owned) and the dispatch table gains no extra entry (wheel
//   is not a keybinding — dispatch.test.ts remains the authoritative
//   untouched pin);
// - ONE consumed wheel return: `handled: true` plus the synthetic target
//   enrichment, reached by every wheel path including the no-op regions —
//   this closes the pre-existing fullscreen SGR-fallthrough hazard by
//   construction;
// - fixed 30-row geometry routing: list region y 5–14, preview region y 17–26,
//   all other rows consumed no-ops;
// - list wheel: sign × |wheelDelta| steps through moveDown (the arrow grow
//   path applies per step) / moveUp, magnitude clamped to the filtered list,
//   zero/absent delta a no-op move — the override itself never re-implements
//   growth;
// - preview wheel: 1 line per notch toward the delta direction via the
//   existing clampPreviewOffset semantics + rebuildPreview.

const selectorSource = fs.readFileSync(
  fileURLToPath(new URL("../extensions/history/index.ts", import.meta.url)),
  "utf8",
);

// T13 — AC-L6-1: wheel-only override + no extra dispatch entry.

test("handleMouse override is wheel-only and the dispatch table keeps 11 entries (AC-L6-1)", () => {
  const decl = selectorSource.indexOf("override handleMouse(");
  assert.ok(decl >= 0, "PromptHistorySelector should override handleMouse");
  const end = selectorSource.indexOf("\n  }", decl);
  assert.ok(end > decl, "handleMouse's body should close");
  const body = selectorSource.slice(decl, end);

  assert.ok(
    body.includes('if (event.type !== "wheel") return undefined;'),
    "non-wheel event types must return undefined (press/click/drag stay host-owned)",
  );
  assert.ok(
    body.includes('ReturnType<Container["handleMouse"]>'),
    'the return type must name the base contract via ReturnType<Container["handleMouse"]>',
  );

  const tableAt = selectorSource.indexOf(
    "private readonly dispatch: readonly DispatchEntry[] = [",
  );
  assert.ok(tableAt >= 0, "the dispatch table should exist");
  const tableEnd = selectorSource.indexOf("\n  ];", tableAt);
  assert.ok(tableEnd > tableAt, "the dispatch table should close");
  const table = selectorSource.slice(tableAt, tableEnd);
  const entries = table.split("match:").length - 1;
  assert.equal(
    entries,
    11,
    "wheel is not a keybinding: exactly the 11 §B2 dispatch entries, no extra",
  );
});

// T13 — AC-L6-2: ONE consumed wheel return with the target enrichment,
// reached by every wheel path including the no-op regions.

test("every wheel path reaches the single handled:true return with target enrichment (AC-L6-2)", () => {
  const decl = selectorSource.indexOf("override handleMouse(");
  assert.ok(decl >= 0, "handleMouse should exist");
  const end = selectorSource.indexOf("\n  }", decl);
  const body = selectorSource.slice(decl, end);

  const returns = body.split("return").length - 1;
  assert.equal(
    returns,
    2,
    "exactly two returns: the guard's undefined and the ONE consumed wheel return",
  );
  assert.equal(
    body.split("handled: true").length - 1,
    1,
    "exactly one handled:true — the single wheel return",
  );
  assert.equal(
    body.split("return {").length - 1,
    1,
    "exactly one object return, so list, preview, and no-op regions all reach it",
  );

  // Synthetic target mirroring dispatchMouseEvent's enrichment math
  // (pi-tui tui.js dispatchMouseEvent: originX = screenX - x, originY =
  // screenY - y, bounds from the event) — the result carries `target`, so
  // dispatch passes it through verbatim.
  assert.ok(body.includes("component: this,"), "target.component: this");
  assert.ok(
    body.includes("originX: event.screenX - event.x,"),
    "target.originX mirrors the dispatch enrichment math",
  );
  assert.ok(
    body.includes("originY: event.screenY - event.y,"),
    "target.originY mirrors the dispatch enrichment math",
  );
  assert.ok(body.includes("width: event.width,"), "target bounds width");
  assert.ok(body.includes("height: event.height,"), "target bounds height");

  // No manual render: pi-tui re-renders handled wheels by default.
  assert.ok(
    !body.includes("requestRender"),
    "handleMouse must not call requestRender (wheel results render by default)",
  );
});

// T13 — AC-L6-3: region routing truth table — the fixed 30-row geometry's
// list band 5–14 and preview band 17–26 appear as the y comparisons, all
// other rows fall through to the consumed no-op return.

test("region constants 5-14 / 17-26 route the y comparisons (AC-L6-3)", () => {
  assert.ok(
    selectorSource.includes("const LIST_WHEEL_Y_FIRST = 5;"),
    "LIST_WHEEL_Y_FIRST = 5 (list container rows)",
  );
  assert.ok(
    selectorSource.includes("const LIST_WHEEL_Y_LAST = 14;"),
    "LIST_WHEEL_Y_LAST = 14",
  );
  assert.ok(
    selectorSource.includes("const PREVIEW_WHEEL_Y_FIRST = 17;"),
    "PREVIEW_WHEEL_Y_FIRST = 17 (preview container rows)",
  );
  assert.ok(
    selectorSource.includes("const PREVIEW_WHEEL_Y_LAST = 26;"),
    "PREVIEW_WHEEL_Y_LAST = 26",
  );

  const decl = selectorSource.indexOf("override handleMouse(");
  assert.ok(decl >= 0, "handleMouse should exist");
  const end = selectorSource.indexOf("\n  }", decl);
  const body = selectorSource.slice(decl, end);

  assert.ok(
    body.includes("event.y >= LIST_WHEEL_Y_FIRST") &&
      body.includes("event.y <= LIST_WHEEL_Y_LAST"),
    "the list branch must compare y against the list band",
  );
  assert.ok(
    body.includes("event.y >= PREVIEW_WHEEL_Y_FIRST") &&
      body.includes("event.y <= PREVIEW_WHEEL_Y_LAST"),
    "the preview branch must compare y against the preview band",
  );
});

// T13 — AC-L6-4: list wheel semantics — sign picks the direction, magnitude
// is clamped to the filtered list, zero/absent delta is a no-op, and the
// routing goes THROUGH moveDown's own grow path (never a re-implementation).

test("list wheel routes sign-clamped steps through moveDown/moveUp (AC-L6-4)", () => {
  const decl = selectorSource.indexOf("override handleMouse(");
  assert.ok(decl >= 0, "handleMouse should exist");
  const end = selectorSource.indexOf("\n  }", decl);
  const body = selectorSource.slice(decl, end);

  // Absent wheelDelta normalizes to 0 → zero steps → no-op move.
  assert.ok(
    body.includes("const delta = event.wheelDelta ?? 0;"),
    "delta must default an absent wheelDelta to 0",
  );

  const listStart = body.indexOf("if (event.y >= LIST_WHEEL_Y_FIRST");
  const listEnd = body.indexOf("} else if (", listStart);
  assert.ok(
    listStart >= 0 && listEnd > listStart,
    "the list branch should exist",
  );
  const listBranch = body.slice(listStart, listEnd);

  assert.ok(
    listBranch.includes(
      "const steps = Math.min(Math.abs(delta), this.filteredRecords.length);",
    ),
    "magnitude must clamp to the filtered list length",
  );
  assert.ok(
    listBranch.includes("for (let i = 0; i < steps; i++) {"),
    "steps must move one row at a time (0 for a zero delta — the no-op)",
  );
  assert.ok(
    listBranch.includes("if (delta > 0) this.moveDown();") &&
      listBranch.includes("else this.moveUp();"),
    "sign semantics: positive delta moves down through moveDown, else up",
  );

  // Prefetch interplay intact: growth belongs to moveDown itself — the
  // override must not re-implement the trigger.
  assert.ok(
    !body.includes("shouldGrowWindow") && !body.includes("nextLoadedCount"),
    "the override must not re-implement growth (wheel-down grows via moveDown)",
  );
});

// T13 — AC-L6-5: preview wheel semantics — one line per notch toward the
// delta direction through the existing clamp, zero-delta no-op.

test("preview wheel scrolls one clamped line per notch (AC-L6-5)", () => {
  const decl = selectorSource.indexOf("override handleMouse(");
  assert.ok(decl >= 0, "handleMouse should exist");
  const end = selectorSource.indexOf("\n  }", decl);
  const body = selectorSource.slice(decl, end);

  const previewStart = body.indexOf("} else if (");
  const previewEnd = body.indexOf("return {", previewStart);
  assert.ok(
    previewStart >= 0 && previewEnd > previewStart,
    "the preview branch should exist",
  );
  const previewBranch = body.slice(previewStart, previewEnd);

  assert.ok(
    previewBranch.includes("if (delta !== 0) {"),
    "a zero delta must be a no-op in the preview band too",
  );
  assert.ok(
    previewBranch.includes("this.previewScrollOffset = clampPreviewOffset("),
    "the preview must scroll through the existing clamp semantics",
  );
  assert.ok(
    previewBranch.includes("this.previewScrollOffset + (delta > 0 ? 1 : -1)"),
    "exactly one line per notch toward the delta direction",
  );
  assert.ok(
    previewBranch.includes("this.wrappedPreviewLines.length") &&
      previewBranch.includes("PREVIEW_ROWS"),
    "the clamp must run against the wrapped length and the viewport rows",
  );
  assert.ok(
    previewBranch.includes("this.rebuildPreview()"),
    "the preview must re-render after the offset change",
  );
});
