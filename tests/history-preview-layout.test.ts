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

test("row padding measures visible width, stripping SGR escapes", () => {
  // Colored list rows carry SGR escape sequences that occupy no terminal
  // cells; padding must use the VISIBLE width or the row falls short of
  // the overlay width and leaves ghost characters on dismiss.
  const renderStart = source.indexOf("  render(width: number): string[] {");
  assert.notStrictEqual(renderStart, -1, "FixedRowText.render should exist");

  const renderSource = source.slice(renderStart, renderStart + 2200);
  const padLine = renderSource
    .split("\n")
    .find((l) => l.includes('" ".repeat(Math.max(0, width -'));
  assert.ok(padLine !== undefined, "final full-width pad should exist");
  assert.ok(
    padLine.includes("visible"),
    "pad must measure the SGR-stripped visible width, not rendered.length",
  );
  assert.ok(
    /visible = rendered\.replace\(/.test(renderSource),
    "visible width must be derived by stripping escape sequences",
  );
});

test("sanitizeForDisplay appends the full astral code point, not a lone surrogate", () => {
  const fnStart = source.indexOf("function sanitizeForDisplay(");
  assert.notStrictEqual(fnStart, -1, "sanitizeForDisplay should exist");

  const fnSource = source.slice(fnStart, fnStart + 1200);
  assert.ok(
    fnSource.includes("String.fromCodePoint(cp)"),
    "astral code points must be re-appended whole (emoji survive)",
  );
  assert.ok(
    fnSource.includes("if (cp > 0xffff) i++"),
    "the low surrogate of the pair must still be skipped",
  );
});
