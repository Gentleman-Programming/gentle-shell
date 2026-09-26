import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import promptHistoryExtension from "../extensions/history/index.ts";
import {
  planHeaderLayout,
  SCOPE_RADIO_COMPACT_GLOBAL,
  SCOPE_RADIO_COMPACT_PROJECT,
  SCOPE_RADIO_FULL_GLOBAL,
  SCOPE_RADIO_FULL_PROJECT,
  scopeRadioText,
} from "../extensions/history/selector-helpers.ts";
import { projectHash } from "../extensions/history/store.ts";

// Responsive selector header (restored from Carolina's #1394 work,
// e2cca1f9b^): the header is fit-driven — inline, stacked (tablet), or
// compact (mobile) — while the overlay stays exactly 30 rows.

const LEFT =
  " History Search ".length +
  " · 1 of 10 ".length +
  " · loaded 10 of 27 ".length;
const RADIO = SCOPE_RADIO_FULL_PROJECT.length;
const GAP = 4;

test("inline while counts plus radio plus minimum gap fit the width", () => {
  assert.equal(
    planHeaderLayout(LEFT + GAP + RADIO, LEFT, RADIO, GAP),
    "inline",
  );
  assert.equal(planHeaderLayout(200, LEFT, RADIO, GAP), "inline");
});

test("stacked (tablet) once the spacer would drop below the minimum gap", () => {
  assert.equal(
    planHeaderLayout(LEFT + GAP + RADIO - 1, LEFT, RADIO, GAP),
    "stacked",
  );
  assert.equal(planHeaderLayout(LEFT, LEFT, RADIO, GAP), "stacked");
});

test("compact (mobile) when even the counts line no longer fits", () => {
  assert.equal(planHeaderLayout(LEFT - 1, LEFT, RADIO, GAP), "compact");
  assert.equal(planHeaderLayout(30, LEFT, RADIO, GAP), "compact");
});

test("radio pins the user-directed labels", () => {
  assert.equal(SCOPE_RADIO_FULL_PROJECT, "◉ Current project | ○ All projects");
  assert.equal(SCOPE_RADIO_FULL_GLOBAL, "○ Current project | ◉ All projects");
  assert.equal(SCOPE_RADIO_COMPACT_PROJECT, "◉ Current project | ○ All");
  assert.equal(SCOPE_RADIO_COMPACT_GLOBAL, "○ Current | ◉ All projects");
});

test("scopeRadioText abbreviates only in compact mode", () => {
  assert.equal(scopeRadioText("project", false), SCOPE_RADIO_FULL_PROJECT);
  assert.equal(scopeRadioText("global", false), SCOPE_RADIO_FULL_GLOBAL);
  assert.equal(scopeRadioText("project", true), SCOPE_RADIO_COMPACT_PROJECT);
  assert.equal(scopeRadioText("global", true), SCOPE_RADIO_COMPACT_GLOBAL);
});

// ---------------------------------------------------------------------------
// Rendered selector: the real overlay component driven through the history
// command with a fake overlay host. Fixtures live under os.tmpdir().
// ---------------------------------------------------------------------------

const CWD = "/pi-history-fixtures/project-header-layout";
const ENTER = "\r";
// 15 prompts, oldest p00 .. newest p14: the header reads
// " History Search  · 1 of 10  · loaded 10 of 15 ".
const PROMPT_COUNT = 15;
const RENDERED_LEFT =
  " History Search ".length +
  " · 1 of 10 ".length +
  " · loaded 10 of 15 ".length;
const INLINE_WIDTH = RENDERED_LEFT + GAP + RADIO;
const STACKED_WIDTH = INLINE_WIDTH - 1;
const COMPACT_WIDTH = RENDERED_LEFT - 1;
const HINT = "Type to filter (multi-word AND substring, case-insensitive)";

interface Selector {
  handleInput(data: string): void;
  handleMouse(event: unknown): unknown;
  render(width: number): string[];
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-header-"));
  const dir = path.join(root, "projects", projectHash(CWD));
  fs.mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: PROMPT_COUNT }, (_, i) =>
    JSON.stringify({
      v: 1,
      text: `p${String(i).padStart(2, "0")}`,
      ts: 1_700_000_000_000 + i,
    }),
  );
  fs.writeFileSync(path.join(dir, "store.jsonl"), `${lines.join("\n")}\n`);
  return root;
}

/**
 * Open the selector through the history command, run `drive` against the
 * mounted component, press Enter, and return the pasted prompt.
 */
async function withSelector(
  drive: (selector: Selector) => void,
): Promise<string | null> {
  const root = makeRoot();
  const commands: Array<[string, { handler: unknown }]> = [];
  promptHistoryExtension(
    {
      on: () => {},
      registerShortcut: () => {},
      registerCommand: (name: string, def: { handler: unknown }) => {
        commands.push([name, def]);
      },
    } as never,
    {
      env: { GENTLE_PI_HISTORY_CAPTURE: "1" },
      gentlePiConfigHome: fs.mkdtempSync(
        path.join(os.tmpdir(), "pi-history-header-config-"),
      ),
      root,
      cwd: CWD,
      instanceId: "inst-header",
      agentDir: path.join(root, "agent"),
      sessionsRoot: path.join(root, "sessions"),
    },
  );
  const command = commands.find(([name]) => name === "history");
  assert.ok(command, "the history command must be registered");
  const handler = command[1].handler as (
    args: unknown,
    ctx: unknown,
  ) => Promise<void>;

  let pasted: string | null = null;
  const plain = (_color: string, text: string) => text;
  const ctx = {
    ui: {
      notify: (message: string) => {
        assert.fail(`unexpected notification: ${message}`);
      },
      pasteToEditor: (text: string) => {
        pasted = text;
      },
      custom: (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: unknown) => void,
        ) => Selector,
      ) =>
        new Promise((resolve) => {
          const selector = factory(
            { requestRender: () => {} },
            { fg: plain, bg: plain, bold: (text: string) => text },
            undefined,
            resolve,
          );
          drive(selector);
          selector.handleInput(ENTER);
          resolve(null);
        }),
    },
  };
  await handler([], ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return pasted;
}

async function renderAt(width: number): Promise<string[]> {
  let lines: string[] = [];
  await withSelector((selector) => {
    lines = selector.render(width);
  });
  return lines;
}

function wheelAt(y: number, width: number): Promise<string | null> {
  return withSelector((selector) => {
    selector.render(width);
    selector.handleMouse({
      type: "wheel",
      wheelDelta: 1,
      x: 1,
      y,
      screenX: 1,
      screenY: y,
      width,
      height: 30,
    });
  });
}

test("inline: title, counts and a right-flushed radio share one row above the hint", async () => {
  const lines = await renderAt(INLINE_WIDTH);
  assert.equal(lines.length, 30, "the overlay stays exactly 30 rows");
  assert.ok(lines[1]!.startsWith(" History Search  · 1 of 10  · loaded 10 of 15 "));
  assert.ok(
    lines[1]!.endsWith(SCOPE_RADIO_FULL_PROJECT),
    "the radio ends flush at the header's last column",
  );
  assert.equal(lines[2]!.trimEnd(), HINT);
  assert.ok(lines[5]!.startsWith("→ p14"), "the list starts at row 5");
});

test("stacked (tablet): the radio wraps under the counts and the hint row is reclaimed", async () => {
  const lines = await renderAt(STACKED_WIDTH);
  assert.equal(lines.length, 30, "the overlay stays exactly 30 rows");
  assert.equal(
    lines[1]!.trimEnd(),
    " History Search  · 1 of 10  · loaded 10 of 15",
  );
  assert.equal(lines[2]!.trimEnd(), ` ${SCOPE_RADIO_FULL_PROJECT}`);
  assert.ok(
    !lines.some((line) => line.includes(HINT)),
    "the hint row gives its row to the radio",
  );
  assert.ok(lines[5]!.startsWith("→ p14"), "the list keeps rows 5-14");
});

test("compact (mobile): counts split across three rows and the list gives up one row", async () => {
  const lines = await renderAt(COMPACT_WIDTH);
  assert.equal(lines.length, 30, "the overlay stays exactly 30 rows");
  assert.equal(lines[1]!.trimEnd(), " History Search  · 1 of 10");
  assert.equal(lines[2]!.trimEnd(), " loaded 10 of 15");
  assert.equal(lines[3]!.trimEnd(), ` ${SCOPE_RADIO_FULL_PROJECT}`);
  assert.ok(lines[6]!.startsWith("→ p14"), "the list starts one row lower");
  assert.ok(
    lines[14]!.startsWith("  p06"),
    "compact paints nine list rows (p14..p06)",
  );
  assert.ok(lines[16]!.includes("Preview"), "the preview block keeps its rows");
});

test("compact abbreviates the radio only when the full radio cannot fit", async () => {
  const lines = await renderAt(RADIO - 1);
  assert.equal(lines.length, 30, "the overlay stays exactly 30 rows");
  assert.equal(lines[3]!.trimEnd(), ` ${SCOPE_RADIO_COMPACT_PROJECT}`);
});

test("the full radio shows exactly when its row, leading space included, fits", async () => {
  // Stacked and compact rows print the radio after one leading space, so
  // the full radio needs RADIO + 1 columns (review advisory A5).
  const fits = await renderAt(RADIO + 1);
  assert.equal(fits[3], ` ${SCOPE_RADIO_FULL_PROJECT}`);
  const tight = await renderAt(RADIO);
  assert.equal(tight[3]!.trimEnd(), ` ${SCOPE_RADIO_COMPACT_PROJECT}`);
  assert.ok(
    tight.slice(1, 4).every((line) => !line.includes("…")),
    "no header row is truncated at the boundary width",
  );
});

test("the list wheel band follows the header mode", async () => {
  // Inline: row 5 is the first list row — wheel down selects p13.
  assert.equal(await wheelAt(5, INLINE_WIDTH), "p13");
  // Compact: row 5 is the search border — a consumed no-op.
  assert.equal(await wheelAt(5, COMPACT_WIDTH), "p14");
  assert.equal(await wheelAt(6, COMPACT_WIDTH), "p13");
});
