import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(
  new URL("../extensions/history/index.ts", import.meta.url),
);
const source = fs.readFileSync(sourcePath, "utf8");

test("preview rows are bottom-padded so the panel shrinks from the bottom", () => {
  const rebuildStart = source.indexOf(
    "private rebuildPreviewWithWidth(width: number): void {",
  );
  assert.notStrictEqual(
    rebuildStart,
    -1,
    "rebuildPreviewWithWidth() should exist",
  );

  const rebuildEnd = source.indexOf(
    "\n  // -- Selection actions",
    rebuildStart,
  );
  assert.notStrictEqual(
    rebuildEnd,
    -1,
    "rebuildPreview section boundary should exist",
  );

  const rebuildPreviewSource = source.slice(rebuildStart, rebuildEnd);

  const rowLoopIndex = rebuildPreviewSource.indexOf(
    "for (let i = 0; i < PREVIEW_ROWS; i++)",
  );
  assert.ok(
    rowLoopIndex >= 0,
    "fixed-height PREVIEW_ROWS row loop should exist",
  );

  const emptyRowPadIndex = rebuildPreviewSource.indexOf(
    "this.previewContainer.addChild(new FixedRowText());",
    rowLoopIndex,
  );
  assert.ok(
    emptyRowPadIndex >= 0,
    "rows past the wrapped content should be added as empty bottom padding",
  );

  assert.ok(
    !rebuildPreviewSource.includes(
      "const topPadding = PREVIEW_ROWS - visible.length;",
    ),
    "preview should not compute top padding",
  );
});
