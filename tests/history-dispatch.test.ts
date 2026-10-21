import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Dispatch table structural tests — source-parsed (AC-P2-1.3, AC-P2-2.1,
 * AC-P2-4.1), following the preview-layout.test.ts pattern.
 *
 * PromptHistorySelector is private to extensions/history/index.ts and needs
 * the pi-tui runtime (Container, Input, TUI, Theme), so these tests read the
 * source file and pin the normative §B2 shape instead of importing it:
 * exactly 12 explicit entries in a fixed order, then the implicit
 * forwardToSearch fallthrough inside handleInput.
 */

const sourcePath = fileURLToPath(
  new URL("../extensions/history/index.ts", import.meta.url),
);
const source = fs.readFileSync(sourcePath, "utf8");

const DISPATCH_DECL = "private readonly dispatch: readonly DispatchEntry[] = [";
const TABLE_CLOSE = "\n  ];";

/** §B2 normative matcher order — the exact literal as it appears per entry. */
const EXPECTED_MATCHERS = [
  'kb.matches(_d, "tui.select.up")',
  'kb.matches(_d, "tui.select.down")',
  'kb.matches(_d, "tui.select.pageUp")',
  'kb.matches(_d, "tui.select.pageDown")',
  'd === "\\r" || kb.matches(d, "tui.select.confirm")',
  'd === "\\t"',
  'kb.matches(_d, "tui.select.cancel")',
  'matchesKey(d, "home")',
  'matchesKey(d, "end")',
  'matchesKey(d, "ctrl+shift+backspace")',
  'matchesKey(d, "ctrl+shift+up")',
  'matchesKey(d, "ctrl+shift+down")',
];

/** Handler each entry must invoke (searched within the entry's body). */
const EXPECTED_HANDLERS = [
  "this.moveUp()",
  "this.moveDown()",
  "this.pageListUp()",
  "this.pageListDown()",
  "this.selectCurrent()",
  "this.toggleScope()",
  "this.onCancel()",
  "this.jumpToFirst()",
  "this.jumpToLast()",
  "this.deleteCurrent()",
  "this.previewPageUp()",
  "this.previewPageDown()",
];

function dispatchTable(): string {
  const start = source.indexOf(DISPATCH_DECL);
  assert.notStrictEqual(
    start,
    -1,
    "dispatch table declaration should exist in extensions/history/index.ts",
  );
  const end = source.indexOf(TABLE_CLOSE, start);
  assert.notStrictEqual(end, -1, "dispatch table closing should exist");
  return source.slice(start, end);
}

/** Entry i's body: from its matcher literal to the next matcher (or table end). */
function entryBody(table: string, index: number): string {
  const start = table.indexOf(EXPECTED_MATCHERS[index]);
  const next =
    index + 1 < EXPECTED_MATCHERS.length
      ? table.indexOf(EXPECTED_MATCHERS[index + 1])
      : table.length;
  return table.slice(start, next === -1 ? table.length : next);
}

function methodBody(name: string): string {
  const start = source.indexOf(`private ${name}(): void {`);
  assert.notStrictEqual(start, -1, `private ${name}() should exist`);
  const end = source.indexOf("\n  }", start);
  assert.notStrictEqual(end, -1, `private ${name}() body should close`);
  return source.slice(start, end);
}

describe("dispatch table (source-parsed, §B2)", () => {
  it("has exactly 12 explicit match: entries (AC-P2-4.1)", () => {
    const table = dispatchTable();
    const matchCount = table.split("match:").length - 1;
    assert.strictEqual(
      matchCount,
      12,
      `expected 12 explicit entries, found ${matchCount}`,
    );
  });

  it("keeps the exact §B2 matcher order", () => {
    const table = dispatchTable();
    let cursor = -1;
    EXPECTED_MATCHERS.forEach((matcher, i) => {
      const at = table.indexOf(matcher);
      assert.notStrictEqual(
        at,
        -1,
        `entry #${i + 1} matcher missing: ${matcher}`,
      );
      assert.ok(
        at > cursor,
        `entry #${i + 1} matcher out of order: ${matcher}`,
      );
      cursor = at;
    });
  });

  it("wires every entry handler per §B2", () => {
    const table = dispatchTable();
    EXPECTED_HANDLERS.forEach((handler, i) => {
      const body = entryBody(table, i);
      assert.ok(
        body.includes(handler),
        `entry #${i + 1} should call ${handler}`,
      );
    });
  });

  it("pages the LIST via pageSelectedIndex and resets the preview offset (AC-P2-1.3)", () => {
    const up = methodBody("pageListUp");
    assert.ok(
      up.includes("pageSelectedIndex("),
      "pageListUp must clamp via pageSelectedIndex",
    );
    assert.ok(
      up.includes("-MAX_VISIBLE"),
      "pageListUp must page up by one page",
    );
    assert.ok(
      up.includes("previewScrollOffset = 0"),
      "pageListUp must reset the preview offset",
    );
    const down = methodBody("pageListDown");
    assert.ok(
      down.includes("pageSelectedIndex("),
      "pageListDown must clamp via pageSelectedIndex",
    );
    assert.ok(
      down.includes("MAX_VISIBLE"),
      "pageListDown must page down by one page",
    );
    assert.ok(
      down.includes("previewScrollOffset = 0"),
      "pageListDown must reset the preview offset",
    );
  });

  it("runs the ctrl+shift combos before the implicit fallthrough (AC-P2-2.1)", () => {
    const table = dispatchTable();
    const lastMatch = table.lastIndexOf("match:");
    assert.ok(
      table.slice(lastMatch).includes('matchesKey(d, "ctrl+shift+down")'),
      "the final table entry must be the ctrl+shift+down combo",
    );
    const loopAt = source.indexOf(
      "for (const { match, handler } of this.dispatch) {",
    );
    const fallthroughAt = source.indexOf(
      "if (!handled) this.forwardToSearch(data);",
    );
    assert.notStrictEqual(loopAt, -1, "dispatch loop should exist");
    assert.notStrictEqual(
      fallthroughAt,
      -1,
      "forwardToSearch fallthrough should exist",
    );
    assert.ok(
      fallthroughAt > loopAt,
      "fallthrough must run after the dispatch loop",
    );
  });
});
