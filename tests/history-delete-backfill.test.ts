import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  deletionActionsFor,
  loadedCountAfterDelete,
} from "../extensions/history/selector-helpers.ts";

// Unit 3 — L4 delete backfill (spec C4, design §B3).
//
// C4's contract as a verbatim two-step: a successful delete splices the
// master snapshot AND shrinks the loaded window together; while unloaded
// rows remain, the window backfills one row (clamped) so the next unloaded
// record slides into the deleted slot and the visible list length stays
// stable; at exhaustion (loadedCount == records.length after the decrement)
// there is NO backfill — the visible set genuinely shrinks by one row, by
// design.
//
// The deleted record always comes from filteredRecords ⊆ the loaded prefix,
// so idx < loadedCount by construction (§B3). Change 1's delete contract
// (delete-prompt.ts, error-only notify) is UNTOUCHED — AC-L4-4's regression
// pin is test/history/delete-prompt.test.ts itself, green and unmodified.

// T11 — AC-L4-1 + AC-L4-2: mid-window delete with unloaded rows remaining —
// the count is preserved by pulling the next record: (30, 99) decrements to
// 29, 29 < 99, so backfill min(29 + 1, 99) = 30 (stable window).

test("loadedCountAfterDelete backfills while unloaded rows remain — stable window (AC-L4-1, AC-L4-2)", () => {
  assert.equal(loadedCountAfterDelete(30, 99), 30);
});

// T11 — AC-L4-3: exhaustion shrink — the window was fully loaded (100 of 100,
// 99 after the splice), so the decrement is the genuine shrink, no backfill:
// 99 < 99 is false → 99.

test("loadedCountAfterDelete shrinks genuinely at exhaustion (AC-L4-3)", () => {
  assert.equal(loadedCountAfterDelete(100, 99), 99);
});

// T11 — AC-L4-3 terminal case: deleting the last loaded row on an exhausted
// window bottoms out at 0: (1, 0) decrements to 0, 0 < 0 is false → 0.

test("loadedCountAfterDelete bottoms out at 0 on the terminal delete (AC-L4-3)", () => {
  assert.equal(loadedCountAfterDelete(1, 0), 0);
});

// T11 — defensive degenerate row: an empty window stays 0 even when counts
// disagree: (0, 5) decrements to −1, −1 < 5, so min(−1 + 1, 5) = 0.
// Unreachable via deleteCurrent (a delete implies a selected row inside the
// loaded prefix) — pinned as C4's defensive bound.

test("loadedCountAfterDelete is defensive for an empty window (AC-L4-1)", () => {
  assert.equal(loadedCountAfterDelete(0, 5), 0);
});

// T11 — AC-L4-1 + AC-L4-4 (source-parse): ordering shape inside deleteCurrent
// — the bookkeeping call sits strictly between the existing splice and the
// trailing applyFilter, INSIDE the existing `if (idx !== -1)` guarded block,
// and the non-`deleted` early return still precedes every mutation
// (Change 1 C1 interplay unchanged).

const selectorSource = fs.readFileSync(
  path.join(process.cwd(), "extensions", "history", "index.ts"),
  "utf8",
);

test("deleteCurrent splices, backfills, then re-filters — inside the guarded block (AC-L4-1, AC-L4-4)", () => {
  const decl = selectorSource.indexOf("private deleteCurrent(");
  assert.ok(decl >= 0, "deleteCurrent should exist");
  const end = selectorSource.indexOf("\n  }", decl);
  assert.ok(end > decl, "deleteCurrent's body should close");
  const body = selectorSource.slice(decl, end);

  const earlyReturnAt = body.indexOf("if (removed === 0) return;");
  const spliceAt = body.indexOf("this.records.splice(");
  const backfillAt = body.indexOf("loadedCountAfterDelete(");
  const refilterAt = body.lastIndexOf("this.applyFilter(");
  assert.ok(earlyReturnAt >= 0, "the Change 1 early return must stay");
  assert.ok(spliceAt >= 0, "the existing splice must stay");
  assert.ok(
    backfillAt >= 0,
    "the loadedCountAfterDelete bookkeeping call must exist",
  );
  assert.ok(refilterAt >= 0, "the trailing applyFilter must stay");
  assert.ok(
    earlyReturnAt < spliceAt &&
      spliceAt < backfillAt &&
      backfillAt < refilterAt,
    "ordering must be: early return → splice → backfill → re-filter",
  );

  // Inside the guarded block: no 4-space block closer may appear between the
  // `if (idx !== -1)` guard and the bookkeeping call (the block's own close
  // sits only AFTER the call).
  const guardAt = body.indexOf("if (idx !== -1)");
  assert.ok(guardAt >= 0, "the `if (idx !== -1)` guard must stay");
  const guardToCall = body.slice(guardAt, backfillAt);
  assert.ok(
    !guardToCall.includes("\n    }"),
    "the bookkeeping must sit inside the `if (idx !== -1)` block",
  );

  // The call assigns this.loadedCount from the unfiltered counts only.
  assert.ok(
    body.includes("this.loadedCount = loadedCountAfterDelete("),
    "the call must assign this.loadedCount",
  );
  const callRegion = body.slice(backfillAt, refilterAt);
  assert.ok(
    callRegion.includes("this.loadedCount") &&
      callRegion.includes("this.records.length"),
    "the bookkeeping must read the unfiltered window and the shrunk snapshot",
  );
});

// Slice 5 scenario pins (porting contract): the tombstone-always rule and
// the partial-failure toast path. The dev suite pins the planner + these
// deleteCurrent branch shapes in hide-prompts.test.ts (T27/T28); this file
// carries the delete-flow source-parse half so the slice-5 branch stays
// pinned inside the delete slice's own tests.

test("deletionActionsFor always plans a tombstone — session provenance deletes nothing from disk", () => {
  // Session/seed-born records: tombstone ONLY (transcripts and the seed are
  // never rewritten by a delete) — the tombstone is what keeps the deleted
  // prompt from resurfacing on the next drain.
  assert.deepEqual(deletionActionsFor("session"), {
    deleteFromEditorStore: false,
    writeTombstone: true,
  });
  // Editor records: disk delete AND tombstone (twin suppression).
  assert.deepEqual(deletionActionsFor("editor"), {
    deleteFromEditorStore: true,
    writeTombstone: true,
  });

  const decl = selectorSource.indexOf("private deleteCurrent(");
  assert.ok(decl >= 0, "deleteCurrent should exist");
  const end = selectorSource.indexOf("\n  }", decl);
  assert.ok(end > decl, "deleteCurrent's body should close");
  const body = selectorSource.slice(decl, end);

  // Branch shape: the tombstone write sits OUTSIDE the editor-store guard —
  // every provenance lands a tombstone, so an entry that came from the
  // seed or a transcript cannot resurface after its delete.
  const editorGuardAt = body.indexOf("if (actions.deleteFromEditorStore)");
  assert.ok(editorGuardAt >= 0, "the editor-store guard must exist");
  const guardCloseAt = body.indexOf("\n    }", editorGuardAt);
  assert.ok(guardCloseAt > editorGuardAt, "the editor-store guard must close");
  const hideAt = body.indexOf("hidePrompt(");
  assert.ok(hideAt >= 0, "the tombstone write must exist");
  assert.ok(
    hideAt > guardCloseAt,
    "the tombstone must follow (not sit inside) the editor-store guard",
  );
});

test("a failed hide toasts and only the session path aborts — the editor path still splices", () => {
  const decl = selectorSource.indexOf("private deleteCurrent(");
  assert.ok(decl >= 0, "deleteCurrent should exist");
  const end = selectorSource.indexOf("\n  }", decl);
  assert.ok(end > decl, "deleteCurrent's body should close");
  const body = selectorSource.slice(decl, end);

  const gateAt = body.indexOf('if (hide.status === "error")');
  assert.ok(gateAt >= 0, "hide errors must be gated");
  const spliceAt = body.indexOf("this.records.splice(");
  assert.ok(
    gateAt < spliceAt,
    "the hide-error gate must precede the splice",
  );
  const gate = body.slice(gateAt, spliceAt);
  assert.ok(
    gate.includes('this.onNotify?.(hide.message, "error")'),
    "a hide error must toast",
  );
  const abortGuardAt = gate.indexOf("if (!actions.deleteFromEditorStore)");
  assert.ok(
    abortGuardAt >= 0,
    "the early return must be exclusive to the session path",
  );
  assert.ok(
    !gate.slice(0, abortGuardAt).includes("return;"),
    "no unconditional abort before the editor/session split — the editor path splices",
  );
});
