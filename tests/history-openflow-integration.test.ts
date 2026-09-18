import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * WU5 tests (AC-S6-1..3): the open-flow wiring in extensions/history/index.ts.
 * NEVER import it — it pulls the pi-tui runtime graph (design §D3). The
 * wiring is pinned by source-parse (command-registration pattern); loader
 * behavior uses fs-only fixtures under the OS temp dir — NEVER the user's
 * real ~/.pi/agent/history.
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

/** Method body slice (lazy-windowing.test.ts pattern; first "\n  }" close). */
function methodBodyOf(name: string): string {
  const decl = indexSource.indexOf(`private ${name}(`);
  assert.ok(decl >= 0, `private ${name}() should exist in extensions/history/index.ts`);
  const end = indexSource.indexOf("\n  }", decl);
  assert.ok(end > decl, `private ${name}() body should close`);
  return indexSource.slice(decl, end);
}

// ---------------------------------------------------------------------------
// T31 — AC-S6-1: store-only drain wiring (source-parse, §I load-bearing shape).
// ---------------------------------------------------------------------------

test("T31 (AC-S6-1): the store drain is the entries source — no live transcript merge (§I pin 1)", () => {
  const body = openHistorySelectorBody();
  const drainIdx = body.indexOf('const entries = drainForScope("project")');
  assert.ok(
    drainIdx >= 0,
    "the load step must drain the store directly (wiring RED seam)",
  );
  assert.ok(
    !body.includes("mergeHistoryEntries("),
    "the live transcript merge is GONE from the open flow (user-directed store-only scopes)",
  );
  assert.ok(
    body.indexOf("if (entries.length === 0)") >= 0,
    "the PR-branch empty guard stands: no history warns instead of opening an empty overlay",
  );
});

test("T31 (AC-S6-1): records are built via recordsFromEntries over the drained entries (§I pins 2+3)", () => {
  const body = openHistorySelectorBody();
  const recIdx = body.indexOf("recordsFromEntries(entries)");
  assert.ok(
    recIdx >= 0,
    "records build through the shared recordsFromEntries helper",
  );
});

test("T31 (AC-S6-1): the three command-registration pins hold beside the swap", () => {
  const definitions =
    indexSource.split("async function openHistorySelector(").length - 1;
  assert.equal(definitions, 1, "openHistorySelector defined exactly once");
  const calls = indexSource.split("openHistorySelector(ctx)").length - 1;
  assert.equal(
    calls,
    2,
    "exactly the two entry-point call sites — the swap adds no occurrence",
  );
});

// ---------------------------------------------------------------------------
// T32 — AC-S6-2: cold-start wiring (no-await source-parse).
// ---------------------------------------------------------------------------

test("T32 (AC-S6-2): NO await on any records build inside openHistorySelector (source-parse)", () => {
  const body = openHistorySelectorBody();
  assert.ok(
    body.includes('const entries = drainForScope("project")'),
    "wiring present (RED seam before GREEN)",
  );
  assert.ok(
    !body.includes("startBackgroundIndexBuild"),
    "the build kick lives inside the loader — never in the selector",
  );
  assert.ok(
    !/await\s+mergeHistoryEntries/.test(body),
    "the open path never awaits the loader (sync const declaration)",
  );
});

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
