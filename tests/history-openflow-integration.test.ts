import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Stage-1 open-flow wiring tests (a22588fc T31/T32 port, adapted to the
 * slice-02 DrainResult drain contract). NEVER import
 * extensions/history/index.ts — it pulls the pi-tui runtime graph (§D3).
 * The wiring is pinned by source-parse (command-registration pattern);
 * loader behavior uses fs-only fixtures under the OS temp dir — NEVER the
 * user's real ~/.pi/agent/history.
 */

const indexSource = fs.readFileSync(
  fileURLToPath(new URL("../extensions/history/index.ts", import.meta.url)),
  "utf8",
);

function openHistorySelectorBody(): string {
  const start = indexSource.indexOf("async function openHistorySelector(");
  assert.ok(start >= 0, "openHistorySelector should exist");
  const end = indexSource.indexOf("export default function", start);
  assert.ok(end > start, "extension entry point should follow");
  return indexSource.slice(start, end);
}

// ---------------------------------------------------------------------------
// T31 (adapted) — store-only drain wiring over the DrainResult contract.
// ---------------------------------------------------------------------------

test("T31 (adapted): the store drain is the entries source — DrainResult unwrapped", () => {
  const body = openHistorySelectorBody();
  const drainIdx = body.indexOf('const drained = drainForScope("project")');
  assert.ok(
    drainIdx >= 0,
    "the load step must drain the store through drainForScope",
  );
  assert.ok(
    !body.includes("mergeHistoryEntries("),
    "no live transcript merge in the open flow (store-only scopes)",
  );
  assert.ok(
    body.includes('drained.status === "blocked"'),
    "the DrainResult blocked variant must be unwrapped before any records build",
  );
  assert.ok(
    body.includes("const entries = drained.prompts"),
    "the ok variant feeds the entries list",
  );
});

test("T31 (adapted): records are built via recordsFromEntries over the drained entries", () => {
  const body = openHistorySelectorBody();
  const recIdx = body.indexOf("recordsFromEntries(entries)");
  assert.ok(
    recIdx >= 0,
    "records build through the shared recordsFromEntries helper",
  );
});

test("T31: the command-registration pins hold beside the drain contract", () => {
  const definitions =
    indexSource.split("async function openHistorySelector(").length - 1;
  assert.equal(definitions, 1, "openHistorySelector defined exactly once");
  const calls = indexSource.split("openHistorySelector(ctx)").length - 1;
  assert.equal(
    calls,
    2,
    "exactly the two entry-point call sites — the drain contract adds no occurrence",
  );
});

// ---------------------------------------------------------------------------
// T32 (adapted) — synchronous open-path wiring (no-await source-parse).
// ---------------------------------------------------------------------------

test("T32 (adapted): the open path never awaits a records build (source-parse)", () => {
  const body = openHistorySelectorBody();
  assert.ok(
    !body.includes("startBackgroundIndexBuild"),
    "no background build kick lives in the selector",
  );
  assert.ok(
    !/await\s+recordsFromEntries/.test(body),
    "the open path never awaits the records build (sync const declaration)",
  );
  const drainIdx = body.indexOf('drainForScope("project")');
  const emptyIdx = body.indexOf("entries.length === 0");
  assert.ok(
    drainIdx >= 0 && emptyIdx > drainIdx,
    "the empty guard follows the drain",
  );
});

// ---------------------------------------------------------------------------
// Stage-1 skeleton pins: the minimal openable unit and its policy seams.
// ---------------------------------------------------------------------------

test("the stage-1 selector skeleton wires cancel through the overlay close", () => {
  assert.ok(
    indexSource.includes('kb.matches(_d, "tui.select.cancel")'),
    "the dispatch table handles cancel",
  );
  assert.ok(
    indexSource.includes("this.onCancel()"),
    "cancel routes to the overlay close callback",
  );
});

test("the selection result pastes into the editor via pasteToEditor", () => {
  const body = openHistorySelectorBody();
  assert.ok(
    body.includes("ctx.ui.pasteToEditor(selected.text)"),
    "the selected prompt enters the editor through the paste pipeline (a22588fc)",
  );
});

/** Method body slice (lazy-windowing.test.ts pattern; first "\n  }" close). */
function methodBodyOf(name: string): string {
  const decl = indexSource.indexOf(`private ${name}(`);
  assert.ok(decl >= 0, `private ${name}() should exist in extensions/history/index.ts`);
  const end = indexSource.indexOf("\n  }", decl);
  assert.ok(end > decl, `private ${name}() body should close`);
  return indexSource.slice(decl, end);
}

// ---------------------------------------------------------------------------
// T33 — AC-S6-3: merged header totals + third transient dim indexing segment.
// ---------------------------------------------------------------------------

test("T33 (AC-S6-3): header totals derive from filteredRecords — derivation untouched", () => {
  const body = methodBodyOf("rebuildListWithWidth");
  assert.ok(
    body.includes("const count = this.filteredRecords.length;"),
    "N derives from filteredRecords (merged by construction)",
  );
});

test("T33 (AC-S6-3): loaded segment present, indexing segment removed", () => {
  const body = methodBodyOf("rebuildListWithWidth");
  const setTextAt = body.indexOf("headerRow.setText(");
  assert.ok(setTextAt >= 0, "the header must keep the existing setText call");
  const setTextRegion = body.slice(
    setTextAt,
    body.indexOf("this.listContainer.clear()"),
  );
  assert.ok(
    setTextRegion.includes("loaded ") &&
      setTextRegion.includes("this.loadedCount"),
    "the loaded segment stays (user-restored)",
  );
  assert.ok(
    !setTextRegion.includes("indexing "),
    "the indexing segment stays removed",
  );
});

test("T33 (AC-S6-3): Change 2 structural pins still hold beside the third segment", () => {
  assert.ok(
    indexSource.includes("private static readonly OVERLAY_LINES = 30;"),
    "OVERLAY_LINES = 30 intact",
  );
  const body = methodBodyOf("rebuildListWithWidth");
  const addChildCount = body.split("addChild(").length - 1;
  assert.equal(addChildCount, 4, "no new addChild in rebuildListWithWidth");
  const classAt = indexSource.indexOf("class PromptHistorySelector");
  const ctorAt = indexSource.indexOf("constructor(", classAt);
  const ctorEnd = indexSource.indexOf('this.applyFilter("")', ctorAt);
  const ctorAddChild =
    indexSource.slice(ctorAt, ctorEnd).split("this.addChild(").length - 1;
  assert.equal(ctorAddChild, 12, "the constructor child sequence is unchanged");
});
