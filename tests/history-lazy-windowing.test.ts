import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildPromptRecords,
  filterPrompts,
  initialLoadedCount,
  loadedCountForQuery,
  loadedCountForTarget,
  moveSelectedIndex,
  nextLoadedCount,
  shouldGrowWindow,
} from "../extensions/history/selector-helpers.ts";

// Unit 2a — L1+L2 windowing helpers (spec C1/C2, design §D3/§D4).
//
// The ratified constant VALUES (design R3) are pinned here as test literals
// while the named constants themselves land in extensions/history/index.ts:
//
//   INITIAL_BATCH = 10 · BATCH_SIZE = 10 · PRELOAD_BUFFER = 3 (trigger at 8th; milestones 10/20/30)
//
// Every helper is a parameterized pure function over UNFILTERED counts only:
// `filteredRecords.length` appears in no trigger or growth expression (the
// §8a regression pin, AC-L2-2). All behaviors below use the helpers exactly
// as the §B2 wiring does in the selector — grow-before-move, one batch per
// threshold crossing, derived exhaustion (no stored flag).

// T4 — AC-L1-1: initial window clamp, min(INITIAL_BATCH, records.length).

test("initialLoadedCount clamps the first-paint window to min(INITIAL_BATCH, records.length) (AC-L1-1)", () => {
  const initialBatch = 30;
  assert.equal(initialLoadedCount(0, initialBatch), 0);
  assert.equal(initialLoadedCount(12, initialBatch), 12);
  assert.equal(initialLoadedCount(30, initialBatch), 30);
  assert.equal(initialLoadedCount(200, initialBatch), 30);
});

// T4 — AC-L1-2: filtering windows the loaded prefix — filterPrompts over
// records.slice(0, loadedCount) derives exclusively from that prefix; a
// match beyond the loaded count stays invisible until growth. filterPrompts
// itself is untouched (imported read-only from selector-helpers.ts).

test("filterPrompts over the loaded prefix hides matches beyond L until growth (AC-L1-2)", () => {
  const records: { text: string; searchText: string }[] = [];
  for (let i = 0; i < 200; i++) {
    const text =
      i === 40 ? "needle40 special prompt" : `plain prompt number ${i}`;
    const [record] = buildPromptRecords([text]);
    assert.ok(record, "buildPromptRecords yields one record per entry");
    records.push(record);
  }

  const loadedPrefix = records.slice(0, initialLoadedCount(200, 30));
  assert.equal(loadedPrefix.length, 30);
  assert.equal(
    filterPrompts(loadedPrefix, "needle40").length,
    0,
    "the match at master index 40 sits beyond the loaded prefix — invisible until growth",
  );
  assert.equal(
    filterPrompts(records.slice(0, 60), "needle40").length,
    1,
    "after growth to cover index 40, the match surfaces",
  );
  assert.equal(
    filterPrompts(loadedPrefix, "").length,
    30,
    "the empty query derives exclusively from the loaded prefix",
  );
});

// T5 — AC-L2-1: trigger truth table with the off-by-one edges. The predicate
// is exactly `selectedIndex + preloadBuffer >= loadedCount` (0-based cursor
// within the final PRELOAD_BUFFER rows of the loaded window).

test("shouldGrowWindow fires exactly when the cursor enters the final PRELOAD_BUFFER rows (AC-L2-1)", () => {
  const totalCount = 200;
  const preloadBuffer = 10;

  // One row early — a naive selected+1 paraphrase would already fire here
  // (spec risk: trigger-expression off-by-one drift).
  assert.equal(shouldGrowWindow(19, 30, totalCount, preloadBuffer), false);
  // Exact boundary: 20 + 10 >= 30.
  assert.equal(shouldGrowWindow(20, 30, totalCount, preloadBuffer), true);
  assert.equal(shouldGrowWindow(29, 30, totalCount, preloadBuffer), true);

  // Grown window: cursor mid-window does not fire, the next final-buffer
  // band does (exact boundary 50 + 10 >= 60).
  assert.equal(shouldGrowWindow(0, 60, totalCount, preloadBuffer), false);
  assert.equal(shouldGrowWindow(49, 60, totalCount, preloadBuffer), false);
  assert.equal(shouldGrowWindow(50, 60, totalCount, preloadBuffer), true);
  assert.equal(shouldGrowWindow(59, 60, totalCount, preloadBuffer), true);
});

// T5 — AC-L2-4 + AC-L1-3: exhaustion is derived — the predicate is false at
// EVERY cursor position once loadedCount equals totalCount, no stored latch.

test("shouldGrowWindow is false at every cursor position once exhausted (AC-L2-4, AC-L1-3)", () => {
  const totalCount = 200;
  for (const cursor of [0, 1, 100, 189, 190, 191, 199, 500]) {
    assert.equal(
      shouldGrowWindow(cursor, 200, totalCount, 10),
      false,
      `cursor ${cursor} on the exhausted window`,
    );
  }
});

// T5 — AC-L1-3/AC-L2-4 (source-parse): exhaustion is derivation-only — the
// selector's class-fields region stores no `exhausted`/`isLoaded` boolean
// that could go stale across query changes.

const selectorSource = fs.readFileSync(
  fileURLToPath(new URL("../extensions/history/index.ts", import.meta.url)),
  "utf8",
);

test("the selector stores no exhausted/isLoaded flag — exhaustion is derivation-only (AC-L1-3, AC-L2-4)", () => {
  const classStart = selectorSource.indexOf("class PromptHistorySelector");
  assert.ok(classStart >= 0, "PromptHistorySelector should exist");
  const dispatchStart = selectorSource.indexOf(
    "private readonly dispatch",
    classStart,
  );
  assert.ok(dispatchStart > classStart, "dispatch table should follow");
  const fieldsRegion = selectorSource.slice(classStart, dispatchStart);
  assert.ok(
    !fieldsRegion.includes("exhausted"),
    "no stored `exhausted` flag may exist in the class fields",
  );
  assert.ok(
    !fieldsRegion.includes("isLoaded"),
    "no stored `isLoaded` flag may exist in the class fields",
  );
});

// T6 — AC-L2-2 (§8a regression pin, helper half): the trigger/growth
// arithmetic lives in pure helpers over UNFILTERED counts only. The helpers
// file must carry no filteredRecords reference and must contain C2's exact
// normative predicate expression.

test("trigger arithmetic is unfiltered-only: exact C2 predicate, no filteredRecords in growth helpers (AC-L2-2)", () => {
  const helpersSource = fs.readFileSync(
    fileURLToPath(
      new URL("../extensions/history/selector-helpers.ts", import.meta.url),
    ),
    "utf8",
  );
  const bodyOf = (name: string): string => {
    const fnStart = helpersSource.indexOf(`export function ${name}`);
    assert.ok(fnStart >= 0, `${name} should exist`);
    const bodyStart = helpersSource.indexOf("{", fnStart);
    const bodyEnd = helpersSource.indexOf("\n}", fnStart);
    assert.ok(bodyStart >= 0 && bodyEnd > bodyStart);
    return helpersSource.slice(bodyStart, bodyEnd);
  };
  for (const name of [
    "shouldGrowWindow",
    "nextLoadedCount",
    "loadedCountForTarget",
  ]) {
    assert.ok(
      !bodyOf(name).includes("filteredRecords"),
      `${name} must read unfiltered counts only`,
    );
  }
  assert.ok(
    bodyOf("shouldGrowWindow").includes(
      "loadedCount < totalCount && selectedIndex + preloadBuffer >= loadedCount",
    ),
    "the predicate must be C2's exact normative expression",
  );
});

// T6 — AC-L2-1/AC-L2-2 (§8a walk): cursor 0→29 over total=200 with the
// ratified constants produces exactly ONE grow (+30 clamped) — one batch
// per threshold crossing, never per-keypress re-triggering.

test("§8a walk: cursor 0→29 over total=200 produces exactly one grow (AC-L2-1, AC-L2-2)", () => {
  const total = 200;
  const batchSize = 30;
  const preloadBuffer = 10;
  let loadedCount = initialLoadedCount(total, 30);
  let grows = 0;
  for (let cursor = 0; cursor <= 29; cursor++) {
    if (shouldGrowWindow(cursor, loadedCount, total, preloadBuffer)) {
      loadedCount = nextLoadedCount(loadedCount, total, batchSize);
      grows++;
    }
  }
  assert.equal(grows, 1, "exactly one batch per threshold crossing");
  assert.equal(loadedCount, 60, "one +30 batch clamped by nothing here");
});

// T6 — AC-L2-2: after that crossing the predicate stays quiet for at least
// 20 more presses — PRELOAD_BUFFER leaves a full-viewport margin (§D3).

test("§8a walk: the next threshold crossing is at least 20 presses away (AC-L2-2)", () => {
  const total = 200;
  const loadedCount = 60; // state right after the first crossing (cursor 20)
  let pressesToNextCrossing: number | null = null;
  for (let cursor = 21; cursor <= total; cursor++) {
    if (shouldGrowWindow(cursor, loadedCount, total, 10)) {
      pressesToNextCrossing = cursor - 21;
      break;
    }
  }
  assert.ok(
    pressesToNextCrossing !== null && pressesToNextCrossing >= 20,
    "the next crossing fires at cursor 50 — 29 presses after the first (a crossing must exist)",
  );
});

// T7 — AC-L1-7: wrap reachability invariant as a pure simulation of the §B2
// wiring: grow-before-move through the helpers, modulo over the loaded set.
// A wrap to index 0 occurs ONLY on the exhausted set; every record index is
// reached (no unloaded row skipped); the walk terminates.

test("wrap-invariant walk: wrap to 0 only when exhausted, every index reached, walk terminates (AC-L1-7)", () => {
  const total = 75;
  const batchSize = 30;
  const preloadBuffer = 10;
  let loadedCount = initialLoadedCount(total, 30);
  let cursor = 0;
  const visited = new Set<number>();
  let wraps = 0;

  for (let step = 0; step < 500; step++) {
    visited.add(cursor);
    // §B2 grow-before-move: fire the C2 trigger, one batch per crossing.
    if (shouldGrowWindow(cursor, loadedCount, total, preloadBuffer)) {
      loadedCount = nextLoadedCount(loadedCount, total, batchSize);
    }
    const next = moveSelectedIndex(cursor, loadedCount, 1);
    if (next === 0) {
      wraps++;
      assert.ok(
        loadedCount >= total,
        "wrap to index 0 must occur only when loadedCount >= records.length",
      );
      break;
    }
    cursor = next;
  }

  assert.equal(wraps, 1, "the walk must terminate via a single full wrap");
  assert.equal(loadedCount, total, "the window must be exhausted at wrap time");
  assert.equal(
    visited.size,
    total,
    "every record index 0..74 must be reached — no unloaded row skipped",
  );
  for (let i = 0; i < total; i++) {
    assert.ok(visited.has(i), `record index ${i} must be reachable`);
  }
});

// T8 — AC-L1-5: loadedCountForTarget table (PgDn catch-up semantics).

test("loadedCountForTarget: covered target is a no-op (AC-L1-5)", () => {
  const total = 200;
  assert.equal(loadedCountForTarget(60, total, 35, 30), 60);
  assert.equal(loadedCountForTarget(30, total, 29, 30), 30);
});

test("loadedCountForTarget: uncovered target grows in whole batches strictly covering it (AC-L1-5)", () => {
  const total = 200;
  // Target row 30 is NOT loaded by loadedCount=30 (rows 0..29) — one batch.
  assert.equal(loadedCountForTarget(30, total, 30, 30), 60);
  assert.equal(loadedCountForTarget(30, total, 35, 30), 60);
  // Strictly covers: row 60 needs rows 0..60, so two batches.
  assert.equal(loadedCountForTarget(30, total, 60, 30), 90);
  assert.equal(loadedCountForTarget(30, total, 61, 30), 90);
});

test("loadedCountForTarget: target past total clamps; exhausted window unchanged (AC-L1-5)", () => {
  assert.equal(loadedCountForTarget(30, 75, 500, 30), 75);
  assert.equal(loadedCountForTarget(75, 75, 500, 30), 75);
  assert.equal(loadedCountForTarget(200, 200, 10, 30), 200);
});

// T8 — AC-L2-1: the growth step is min(L + max(1, batchSize), R); the
// max(1, ·) guard is what keeps loadedCountForTarget's loop terminating on
// a degenerate (or negative) batch size.

test("nextLoadedCount steps min(L + max(1, batchSize), R) including the degenerate-batch guard (AC-L2-1)", () => {
  assert.equal(nextLoadedCount(30, 200, 30), 60);
  assert.equal(nextLoadedCount(90, 200, 30), 120);
  assert.equal(nextLoadedCount(180, 200, 30), 200, "clamped at total");
  assert.equal(nextLoadedCount(200, 200, 30), 200, "exhausted: no-op clamp");
  assert.equal(nextLoadedCount(30, 200, 0), 31, "degenerate batch adds 1");
  assert.equal(nextLoadedCount(30, 200, -5), 31, "negative batch adds 1");
});

// ---------------------------------------------------------------------------
// Unit 2b — §B2 wiring pins (T9) + headerRow-only constraint (T10).
//
// Source-parse tests over extensions/history/index.ts. The body extractor
// mirrors dispatch.test.ts's methodBody(): slice from the method declaration
// to the first "\n  }" — which is exactly why every nested if added by the
// §B2 wiring must close at 4-space indent (a 4-space closer cannot match the
// first-close slice, so the method close is still found).
//
// Slice-3 adaptation note: upstream wires the growth trigger INLINE in
// moveUp/moveDown (no shared growLoadedWindowIfNeeded helper — that shape is
// dev-repo drift). The pins below assert the same AC contracts against the
// inline form.

function methodBodyOf(name: string): string {
  const decl = selectorSource.indexOf(`private ${name}(`);
  assert.ok(decl >= 0, `private ${name}() should exist in extensions/history/index.ts`);
  const end = selectorSource.indexOf("\n  }", decl);
  assert.ok(end > decl, `private ${name}() body should close`);
  return selectorSource.slice(decl, end);
}

// T9 — AC-L1-4: batch append points — growth wiring in the three downward
// paths ONLY (moveUp carries the older-direction growth check); every other
// upward site and applyFilter stay pure.

test("growth wiring appears in moveDown, moveUp, pageListDown, jumpToLast (AC-L1-4)", () => {
  const down = methodBodyOf("moveDown");
  assert.ok(
    down.includes("shouldGrowWindow("),
    "moveDown must evaluate the C2 trigger",
  );
  assert.ok(
    down.includes("nextLoadedCount("),
    "moveDown must grow via nextLoadedCount",
  );
  const up = methodBodyOf("moveUp");
  assert.ok(
    up.includes("shouldGrowWindow(") && up.includes("nextLoadedCount("),
    "moveUp must carry the older-direction growth check",
  );
  const pageDown = methodBodyOf("pageListDown");
  assert.ok(
    pageDown.includes("loadedCountForTarget("),
    "pageListDown must catch up via loadedCountForTarget",
  );
  const jumpLast = methodBodyOf("jumpToLast");
  assert.ok(
    jumpLast.includes("this.loadedCount = this.records.length;"),
    "jumpToLast must one-shot the full load (End)",
  );
  for (const name of ["pageListUp", "jumpToFirst", "applyFilter"]) {
    const body = methodBodyOf(name);
    for (const grow of [
      "shouldGrowWindow(",
      "nextLoadedCount(",
      "loadedCountForTarget(",
    ]) {
      assert.ok(
        !body.includes(grow),
        `${name} must never grow (found ${grow})`,
      );
    }
  }
});

// T9 — AC-L1-7 / AC-L1-5 / AC-L1-6 ordering: growth runs BEFORE the index
// computation in every downward path (grow-before-move, design §B2/§D1).

test("growth runs BEFORE the index computation in every downward path (AC-L1-7, AC-L1-5, AC-L1-6)", () => {
  const down = methodBodyOf("moveDown");
  const growAt = down.indexOf("shouldGrowWindow(");
  assert.notEqual(growAt, -1, "moveDown must evaluate the C2 trigger");
  assert.ok(
    growAt < down.indexOf("moveSelectedIndex("),
    "moveDown must grow before the modulo — wrap-to-0 only on the exhausted set",
  );
  const page = methodBodyOf("pageListDown");
  const catchUpAt = page.indexOf("loadedCountForTarget(");
  assert.notEqual(catchUpAt, -1, "pageListDown must run the PgDn catch-up");
  assert.ok(
    catchUpAt < page.indexOf("pageSelectedIndex("),
    "pageListDown must load the paged-to row before the selection lands",
  );
  const last = methodBodyOf("jumpToLast");
  const fullLoad = last.indexOf("this.loadedCount = this.records.length;");
  const guard = last.indexOf("if (this.filteredRecords.length === 0) return;");
  assert.ok(
    fullLoad !== -1 && guard !== -1 && fullLoad < guard,
    "jumpToLast must full-load before the empty guard so End surfaces unloaded matches",
  );
});

// T9 — AC-L2-2 (§8a regression pin, wiring half): the trigger/growth call
// arguments read ONLY the unfiltered counts — `filteredRecords` appears in
// no growth region of any downward body.

test("growth arithmetic names only this.loadedCount and this.records.length (AC-L2-2)", () => {
  const down = methodBodyOf("moveDown");
  const downGrow = down.slice(0, down.indexOf("moveSelectedIndex("));
  assert.ok(
    downGrow.includes("shouldGrowWindow(") &&
      downGrow.includes("nextLoadedCount("),
    "moveDown's growth region must run the trigger + one batch before the modulo",
  );
  assert.ok(
    !downGrow.includes("filteredRecords"),
    "moveDown's pre-modulo region must read UNFILTERED counts only",
  );
  const page = methodBodyOf("pageListDown");
  const pageGrow = page.slice(0, page.indexOf("pageSelectedIndex("));
  assert.ok(
    pageGrow.includes("loadedCountForTarget(") &&
      pageGrow.includes("this.loadedCount") &&
      pageGrow.includes("this.records.length"),
    "pageListDown's catch-up must pass the unfiltered counts",
  );
  assert.ok(
    !pageGrow.includes("filteredRecords"),
    "pageListDown's growth arithmetic must read UNFILTERED counts only",
  );
  const last = methodBodyOf("jumpToLast");
  const guardAt = last.indexOf(
    "if (this.filteredRecords.length === 0) return;",
  );
  const lastGrow = last.slice(0, guardAt);
  assert.ok(
    lastGrow.includes("this.loadedCount = this.records.length;") &&
      !lastGrow.includes("filteredRecords"),
    "jumpToLast's full-load region must be unfiltered-only",
  );
});

// T9 — AC-L2-3 (typing never loads) + AC-L1-2: applyFilter derives matches
// from the loaded prefix and contains no grow call.

test("applyFilter windows the loaded prefix and grows only via loadedCountForQuery (AC-L2-3r, AC-L1-2)", () => {
  const body = methodBodyOf("applyFilter");
  assert.ok(
    body.includes("filterPrompts(") &&
      body.includes(".slice(0, this.loadedCount)"),
    "applyFilter must derive matches from records.slice(0, loadedCount)",
  );
  assert.ok(
    body.includes("loadedCountForQuery("),
    "applyFilter must route visibility through loadedCountForQuery (AC-L2-3r)",
  );
  assert.ok(
    !body.includes("nextLoadedCount("),
    "typing implies one-shot full visibility via loadedCountForQuery; incremental loads stay banned (C2)",
  );
  assert.ok(
    !body.includes("shouldGrowWindow("),
    "the filter path must never trigger growth",
  );
});

// T10 — AC-L3-2: headerRow-only constraint — the suffix is produced inside
// rebuildListWithWidth's existing headerRow.setText argument, adds no row
// (no new addChild in the method, constructor child sequence unchanged) and
// OVERLAY_LINES = 30 stays intact.

test("the header keeps the position segment plus the loaded suffix on the existing headerRow.setText path (AC-L3-2)", () => {
  const body = methodBodyOf("rebuildListWithWidth");
  const setTextAt = body.indexOf("headerRow.setText(");
  assert.ok(
    setTextAt >= 0,
    "the suffix must extend the existing headerRow.setText call",
  );
  const setTextRegion = body.slice(
    setTextAt,
    body.indexOf("this.listContainer.clear()"),
  );
  assert.ok(
    setTextRegion.includes("loaded ") &&
      setTextRegion.includes("this.loadedCount") &&
      setTextRegion.includes("this.records.length"),
    "the ` · loaded M of T ` suffix must be produced inside the setText argument",
  );
  assert.ok(
    !setTextRegion.includes("indexing "),
    "no indexing segment — removed by user decision",
  );
  const addChildCount = body.split("addChild(").length - 1;
  assert.equal(
    addChildCount,
    4,
    "the suffix adds no addChild call — today's 4 list-row sites unchanged",
  );
  assert.ok(
    selectorSource.includes("private static readonly OVERLAY_LINES = 30;"),
    "OVERLAY_LINES = 30 must stay intact",
  );
  const classAt = selectorSource.indexOf("class PromptHistorySelector");
  const ctorAt = selectorSource.indexOf("constructor(", classAt);
  const ctorEnd = selectorSource.indexOf('this.applyFilter("")', ctorAt);
  const ctorAddChild =
    selectorSource.slice(ctorAt, ctorEnd).split("this.addChild(").length - 1;
  assert.equal(ctorAddChild, 12, "the constructor child sequence is unchanged");
});

// T14 — AC-L2-3 revision (user-directed 2026-09-08): a non-empty query
// implies full-snapshot visibility, one-shot and idempotent; an empty or
// whitespace-only query leaves the window untouched. Per-keypress
// incremental growth remains banned (the helper returns total, never +BATCH).

test("loadedCountForQuery: non-empty query returns total, empty keeps window (AC-L2-3r)", () => {
  assert.equal(loadedCountForQuery(10, 512, "deploy"), 512);
  assert.equal(loadedCountForQuery(10, 512, ""), 10);
  assert.equal(loadedCountForQuery(10, 512, "   "), 10);
  assert.equal(loadedCountForQuery(512, 512, "deploy"), 512);
  assert.equal(loadedCountForQuery(10, 10, "x"), 10);
});
