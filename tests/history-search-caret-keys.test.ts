import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import promptHistoryExtension from "../extensions/history/index.ts";
import { projectHash } from "../extensions/history/store.ts";

// Home/End routing in the history selector: with text in the search box
// they move the search caret (End never jumps or loads the list); with an
// empty search box they keep the documented list jumps (§B2/§D7). The real
// selector is driven through the history command with a fake overlay host;
// every fixture lives under os.tmpdir(), never the user's real ~/.pi.

const CWD = "/pi-history-fixtures/project-caret-keys";
const HOME = "\x1b[H";
const END = "\x1b[F";
const LEFT = "\x1b[D";
const ENTER = "\r";
// 15 prompts, oldest p00 .. newest p14: more than the initial 10-row window.
const PROMPT_COUNT = 15;

interface Selector {
  handleInput(data: string): void;
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-caret-"));
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
 * Open the selector, feed `keys` one at a time, and return the prompt the
 * selector pasted into the editor (null when it pasted nothing).
 */
async function selectAfter(keys: string[]): Promise<string | null> {
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
        path.join(os.tmpdir(), "pi-history-caret-config-"),
      ),
      root,
      cwd: CWD,
      instanceId: "inst-caret",
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
          for (const key of keys) selector.handleInput(key);
          // Enter selects the highlighted row; with no match it resolves
          // nothing, so close explicitly to finish the command.
          selector.handleInput(ENTER);
          resolve(null);
        }),
    },
  };
  await handler([], ctx);
  // The paste path schedules one render tick; let it drain.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return pasted;
}

test("with a query, Home moves the search caret instead of the list", async () => {
  // Typed "1", caret to the start, then "p": the query is "p1", whose
  // newest match is p14. A list jump would leave the query as "1p".
  assert.equal(await selectAfter(["1", HOME, "p"]), "p14");
});

test("with a query, End moves the search caret instead of the list", async () => {
  // Caret moved to the start, End brings it back: "p1" + "3" = "p13".
  // A list jump would leave the caret at 0 and type "3p1".
  assert.equal(await selectAfter(["p", "1", LEFT, LEFT, END, "3"]), "p13");
});

test("with a query, End neither jumps to the last match nor loads the list", async () => {
  // A real query: the highlighted row stays the newest match, not p00.
  assert.equal(await selectAfter(["p", END]), "p14");
  // A whitespace-only query filters nothing and keeps the 10-row window:
  // End must not load every record and select the oldest one.
  assert.equal(await selectAfter([" ", END]), "p14");
});

test("with an empty query, Home and End keep the list jumps", async () => {
  // End loads every record and selects the oldest one (§D7).
  assert.equal(await selectAfter([END]), "p00");
  // Home jumps back to the newest.
  assert.equal(await selectAfter([END, HOME]), "p14");
  // Emptying the query hands Home/End back to the list.
  assert.equal(await selectAfter(["p", "\x7f", END]), "p00");
});
