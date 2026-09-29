import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterPrompts } from "../extensions/history/selector-helpers.ts";

/**
 * WU5 tests (AC-S5-1, AC-S5-2): the MAX_RESULTS raise 1000 → 10000 is an
 * OUTPUT cap only — filterPrompts caps both of its slice sites; the load
 * path never snapshots. Pure import (no pi-tui graph) plus a source-parse
 * pin on the selector-helpers slice sites.
 *
 * The dev suite's openHistorySelector body pin (no slice() on the load
 * path) covers the slice-3 selector wiring in extensions/history/index.ts
 * and ports with that slice — index.ts stays at its slice-1 surface here.
 */

interface CapRecord {
  text: string;
  searchText: string;
}

function record(text: string): CapRecord {
  return { text, searchText: text.toLowerCase() };
}

// T29 — AC-S5-1: the cap value. More than 10,000 records → exactly 10,000 at
// the empty-query slice AND at a filtered-query slice. NEW pin — no existing
// test pins the old 1000 literal (design §D9; zero existing-test edits
// repo-wide, so this file ADDS the pin instead of editing one).

test("T29 (AC-S5-1): empty-query slice caps at the raised 10000", () => {
  const records: CapRecord[] = [];
  for (let i = 0; i < 10500; i++) {
    records.push(record(`unique prompt number ${i}`));
  }
  const result = filterPrompts(records, "");
  assert.equal(result.length, 10000);
});

test("T29 (AC-S5-1): filtered-query slice caps at the raised 10000", () => {
  const records: CapRecord[] = [];
  // 10,500 matches for the query token plus non-matching padding rows: the
  // FILTERED set alone is above the cap, so the filtered slice site is the
  // one being exercised here.
  for (let i = 0; i < 10500; i++) {
    records.push(record(`match me ${i}`));
  }
  records.push(record("unrelated row one"));
  records.push(record("unrelated row two"));
  const result = filterPrompts(records, "match");
  assert.ok(result.length > 1000, "the filtered set must exceed the old cap");
  assert.equal(result.length, 10000);
  assert.ok(result.every((r) => r.searchText.includes("match")));
});

// T30 — AC-S5-2: output-cap-only semantics (source-parse). Selector-helpers
// reads the constant at exactly the two sanctioned filterPrompts slice
// sites — no other cap exists in the helper module.

const helperSource = fs.readFileSync(
  fileURLToPath(
    new URL("../extensions/history/selector-helpers.ts", import.meta.url),
  ),
  "utf8",
);

test("T30 (AC-S5-2): filterPrompts hosts exactly the two sanctioned cap slice sites", () => {
  const sliceSites = helperSource.split("slice(0, MAX_RESULTS)").length - 1;
  assert.equal(
    sliceSites,
    2,
    "filterPrompts hosts exactly the two sanctioned cap slice sites",
  );
});
