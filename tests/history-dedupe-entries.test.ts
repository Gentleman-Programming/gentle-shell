import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { dedupePromptEntries } from "../extensions/history/selector-helpers.ts";

// AC-L5-1..AC-L5-5 — read-time dedup pass (spec C3, design §D5).
//
// The normalization key MUST byte-match the APPLIED patch form from
// nav/patches/editor.cjs :480–:586:
//
//   entry.replace(/\s+/g, " ").trim().slice(0, 120).toLowerCase()
//
// The raw patch file stores `\\s+` because the replacement code sits inside
// a template literal; the code that actually runs in the editor contains
// `/\s+/g`. An implementation copying the double-backslash form would build
// a regex matching a literal backslash: whitespace variants would stop
// collapsing (T1 fails) and empty-key entries would leak through (T2 fails).

// T1 — AC-L5-1: keep-first over newest-first input order (file order).

test("keep-first: [A, B, A″] where A″ normalizes equal to A yields [A, B] (AC-L5-1)", () => {
  const a = "deploy the API";
  const b = "write the tests";
  const aDoublePrime = "deploy  the API";
  assert.deepEqual(dedupePromptEntries([a, b, aDoublePrime]), [a, b]);
});

// T1 — AC-L5-2: normalization groups each collapse to their first entry.

test("normalization group: internal whitespace runs collapse to the first entry (AC-L5-2)", () => {
  const first = "run the build now";
  assert.deepEqual(
    dedupePromptEntries([
      first,
      "run  the  build  now",
      "run the build now   ",
      "   run the build now",
    ]),
    [first],
  );
});

test("normalization group: tabs and newlines collapse to the first entry (AC-L5-2)", () => {
  const first = "run the build now";
  assert.deepEqual(
    dedupePromptEntries([
      first,
      "run\tthe\tbuild\tnow",
      "run\nthe\nbuild\nnow",
      "run \t the \n build now",
    ]),
    [first],
  );
});

test("normalization group: letter case collapses to the first entry (AC-L5-2)", () => {
  const first = "Run The Build NOW";
  assert.deepEqual(
    dedupePromptEntries([first, "run the build now", "RUN THE BUILD NOW"]),
    [first],
  );
});

// T1 — AC-L5-2: 120-char normalized prefix collisions collapse (accepted
// patch-mirror semantics, NOT the P5 dedup-key fix).

test("entries sharing the normalized 120-char prefix but differing later collapse (AC-L5-2)", () => {
  const prefix = "x".repeat(120);
  const first = `${prefix} tail one`;
  const second = `${prefix} tail two`;
  assert.deepEqual(dedupePromptEntries([first, second]), [first]);
});

test("entries differing within the first 120 normalized chars stay distinct (AC-L5-2)", () => {
  const a = `${"x".repeat(119)}a ${"y".repeat(10)}`;
  const b = `${"x".repeat(119)}b ${"y".repeat(10)}`;
  assert.deepEqual(dedupePromptEntries([a, b]), [a, b]);
});

// T2 — AC-L5-3: empty-key entries (empty string, whitespace-only) are
// skipped: excluded from the output, never usable as collision keys, real
// entries pass through.

test("empty-key entries are excluded from the output while real entries pass through (AC-L5-3)", () => {
  const real = "a real prompt";
  assert.deepEqual(dedupePromptEntries(["", "   ", "\t\n  ", real, "\t"]), [
    real,
  ]);
});

test("whitespace-only entries never shadow real entries as collision keys (AC-L5-3)", () => {
  const first = "another real prompt";
  assert.deepEqual(dedupePromptEntries(["", "  ", first]), [first]);
});

// T2 — AC-L5-5: no truncation beyond duplicate removal (no snapshot cap).

test("output length equals input length minus duplicate-normalized entries (AC-L5-5)", () => {
  const entries = [
    "alpha",
    "alpha", // duplicate of 0
    "beta",
    " ALPHA ", // duplicate of 0 (case + whitespace)
    "beta\t", // duplicate of 2
    "gamma",
  ];
  assert.equal(dedupePromptEntries(entries).length, 3);
});

test("no snapshot cap: every unique entry is kept past MAX_RESULTS (AC-L5-5)", () => {
  const entries: string[] = [];
  for (let i = 0; i < 1200; i++) {
    entries.push(`unique prompt number ${i}`);
  }
  const deduped = dedupePromptEntries(entries);
  assert.equal(deduped.length, 1200);
  assert.equal(deduped[0], entries[0]);
  assert.equal(deduped[1199], entries[1199]);
});

// T3 — AC-L5-4 (source-parse, command-registration.test.ts pattern): never
// import src/index.ts — it pulls the pi-tui runtime graph (design §D3).

const sourcePath = fileURLToPath(new URL("../extensions/history/index.ts", import.meta.url));
const source = fs.readFileSync(sourcePath, "utf8");

test("dedupePromptEntries is wired between the store drain and buildPromptRecords in openHistorySelector (AC-L5-4)", () => {
  const loadIdx = source.indexOf('drainForScope("project")');
  assert.ok(
    loadIdx >= 0,
    "store drain call should exist in openHistorySelector",
  );

  const dedupeCallIdx = source.indexOf("dedupePromptEntries(", loadIdx);
  assert.ok(
    dedupeCallIdx > loadIdx,
    "dedup invocation must come after the store drain call",
  );

  const buildIdx = source.indexOf("buildPromptRecords(");
  assert.ok(
    buildIdx > loadIdx,
    "buildPromptRecords call should follow the loadSharedHistory call",
  );
  assert.ok(
    source
      .slice(buildIdx, buildIdx + "buildPromptRecords(".length + 40)
      .includes("dedupePromptEntries(entries)"),
    "records must be built from dedupePromptEntries(entries) — the read-time dedup runs between load and build (design §B1)",
  );
});

test("the three command-registration pins still hold beside the dedup wiring (AC-L5-4)", () => {
  const definitions =
    source.split("async function openHistorySelector(").length - 1;
  assert.strictEqual(
    definitions,
    1,
    "openHistorySelector should be defined exactly once",
  );

  const calls = source.split("openHistorySelector(ctx)").length - 1;
  assert.strictEqual(
    calls,
    2,
    "the dedup wiring must add no openHistorySelector(ctx) occurrence",
  );

  const start = source.indexOf("async function openHistorySelector(");
  const end = source.indexOf("export default function", start);
  assert.notStrictEqual(end, -1, "extension entry point should follow");
  const body = source.slice(start, end);
  assert.ok(
    !body.includes('"No prompt history available."'),
    "the warning is removed; the selector always opens",
  );
});
