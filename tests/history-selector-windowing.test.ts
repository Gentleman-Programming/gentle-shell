import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptRecords,
  clampPreviewOffset,
  clampSelectedIndex,
  computeVisibleRange,
  getVisiblePromptRecords,
  moveSelectedIndex,
  pageSelectedIndex,
} from "../extensions/history/selector-helpers.ts";

test("buildPromptRecords lowercases search text", () => {
  assert.deepEqual(buildPromptRecords(["Hello"]), [
    { text: "Hello", searchText: "hello" },
  ]);
});

test("computeVisibleRange centers when possible", () => {
  assert.deepEqual(computeVisibleRange(8, 30, 10), { start: 3, end: 13 });
});

test("computeVisibleRange pins near end", () => {
  assert.deepEqual(computeVisibleRange(28, 30, 10), { start: 20, end: 30 });
});

test("computeVisibleRange handles small lists", () => {
  assert.deepEqual(computeVisibleRange(1, 3, 10), { start: 0, end: 3 });
});

test("clampSelectedIndex stays within filtered record bounds", () => {
  assert.equal(clampSelectedIndex(8, 3), 2);
  assert.equal(clampSelectedIndex(1, 0), 0);
});

test("clampPreviewOffset clamps offsets past the last page", () => {
  assert.equal(clampPreviewOffset(50, 47, 10), 37);
  assert.equal(clampPreviewOffset(5, 47, 10), 5);
});

test("clampPreviewOffset pins to zero when content fits the viewport", () => {
  assert.equal(clampPreviewOffset(3, 8, 10), 0);
  assert.equal(clampPreviewOffset(7, 0, 10), 0);
});

test("moveSelectedIndex wraps around the list", () => {
  assert.equal(moveSelectedIndex(0, 3, -1), 2);
  assert.equal(moveSelectedIndex(2, 3, 1), 0);
  assert.equal(moveSelectedIndex(0, 0, 1), 0);
});

test("pageSelectedIndex clamps within the list", () => {
  assert.equal(pageSelectedIndex(8, 30, -10), 0);
  assert.equal(pageSelectedIndex(2, 3, 10), 2);
  assert.equal(pageSelectedIndex(0, 0, 10), 0);
});

test("pageSelectedIndex end-clamps a downward page at the last entry (AC-P2-1.1)", () => {
  assert.equal(pageSelectedIndex(28, 30, 10), 29);
  assert.equal(pageSelectedIndex(25, 30, 10), 29);
});

test("pageSelectedIndex clamps |pageSize| greater than total in both directions (AC-P2-1.2)", () => {
  assert.equal(pageSelectedIndex(0, 3, 10), 2);
  assert.equal(pageSelectedIndex(2, 3, -10), 0);
  assert.equal(pageSelectedIndex(0, 30, -50), 0);
});

test("pageSelectedIndex never wraps past the ends (AC-P2-1.2)", () => {
  assert.equal(pageSelectedIndex(29, 30, 10), 29);
  assert.equal(pageSelectedIndex(0, 30, -10), 0);
});

test("getVisiblePromptRecords returns visible records with selection state", () => {
  assert.deepEqual(
    getVisiblePromptRecords(
      buildPromptRecords(["one", "two", "three", "four"]),
      2,
      2,
    ),
    [
      {
        index: 1,
        record: { text: "two", searchText: "two" },
        isSelected: false,
      },
      {
        index: 2,
        record: { text: "three", searchText: "three" },
        isSelected: true,
      },
    ],
  );
});
