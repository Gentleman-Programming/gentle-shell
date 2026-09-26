import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Source-parsing tests (a22588fc port, stage-1 surface): never import
// extensions/history/index.ts — it pulls the pi-tui runtime graph (§D3).

const sourcePath = fileURLToPath(
  new URL("../extensions/history/index.ts", import.meta.url),
);
const source = fs.readFileSync(sourcePath, "utf8");

/** The open-flow body: openHistorySelector up to the extension entry point. */
function openFlowBody(): string {
  const start = source.indexOf("async function openHistorySelector(");
  assert.ok(start >= 0, "openHistorySelector should exist");
  const end = source.indexOf("export default function", start);
  assert.notStrictEqual(end, -1, "extension entry point should follow");
  return source.slice(start, end);
}

test("openHistorySelector is extracted once and shared by both entry points", () => {
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
    "registerShortcut and registerCommand handlers should both call openHistorySelector(ctx)",
  );
});

test("an empty history warns and skips the overlay (a22588fc empty-store policy)", () => {
  const body = openFlowBody();
  assert.ok(
    body.includes("entries.length === 0") &&
      body.includes('"No prompt history available."'),
    "an empty history warns and skips the overlay (slice-03 policy; a later slice changes it)",
  );
});

test("the /history command is registered beside the shortcut", () => {
  const index = source.indexOf('pi.registerCommand("history"');
  assert.ok(index >= 0, 'pi.registerCommand("history", ...) should exist');

  const slice = source.slice(index, index + 200);
  assert.ok(
    slice.includes('"Search prompt history"'),
    "command should carry the same description as the shortcut",
  );
  assert.ok(
    slice.includes("openHistorySelector(ctx)"),
    "command handler should route through the shared entry point",
  );
});

test("the ctrl+shift+r shortcut is registered with the shared description", () => {
  const index = source.indexOf("pi.registerShortcut(SHORTCUT");
  assert.ok(index >= 0, "pi.registerShortcut(SHORTCUT, ...) should exist");

  const slice = source.slice(index, index + 200);
  assert.ok(
    slice.includes('"Search prompt history"'),
    "shortcut should carry the shared description",
  );
  assert.ok(
    slice.includes("openHistorySelector(ctx)"),
    "shortcut handler should route through the shared entry point",
  );
});

test("the SHORTCUT constant pins ctrl+shift+r", () => {
  assert.ok(
    source.includes('const SHORTCUT = "ctrl+shift+r";'),
    "the shortcut key must stay ctrl+shift+r",
  );
});

test("the capture gate precedes every store touch in the open flow (#1390)", () => {
  const body = openFlowBody();
  const gateAt = body.indexOf("if (!captureEnabled(env))");
  const drainAt = body.indexOf('drainForScope("project")');
  assert.ok(gateAt >= 0, "the open flow must check captureEnabled first");
  assert.ok(
    drainAt > gateAt,
    "the drain must run only after the capture gate passes",
  );
  assert.ok(
    body.includes("GENTLE_PI_HISTORY_CAPTURE"),
    "the disabled warning names the capture switch",
  );
  // No writer init on the open path: the selector never touches the
  // registry or the capture writer — getWriter stays capture-side.
  assert.ok(
    !body.includes("getWriter()"),
    "the open flow must not initialize the capture writer",
  );
});

test("a blocked drain stops the open flow with an error and no records", () => {
  const body = openFlowBody();
  const blockedAt = body.indexOf('drained.status === "blocked"');
  assert.ok(
    blockedAt >= 0,
    "the slice-02 DrainResult blocked variant must be handled",
  );
  const recordsAt = body.indexOf("recordsFromEntries(entries)");
  assert.ok(
    recordsAt > blockedAt,
    "records build only after the blocked check (fail-closed)",
  );
  assert.ok(
    body.includes('ctx.ui.notify(drained.message, "error")'),
    "the blocked recovery message surfaces as an error notification",
  );
});
