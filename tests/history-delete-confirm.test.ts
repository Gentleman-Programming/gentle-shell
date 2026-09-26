import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deleteConfirmFooterText,
  deleteConfirmStep,
  deletionActionsFor,
  EDITOR_HIDE_FAILED_TEXT,
  STORE_DELETE_FAILED_TEXT,
  STORE_DELETE_PARTIAL_TEXT,
  storeDeleteFollowUp,
} from "../extensions/history/selector-helpers.ts";

// Slice-05 delete-confirm tests (PR #1393 follow-up): the delete
// confirmation is a MODAL y/n step. The first ctrl+shift+backspace press
// ARMS the delete for the selected row (confirmation footer + highlighted
// record) and executes NOTHING; while armed, y executes, n/Esc cancels,
// and every other key is swallowed with the confirm still armed — nothing
// reaches the dispatch table or the search input. Session-derived rows
// are read-only: a delete press on one is a silent no-op.
//
// PromptHistorySelector is private to extensions/history/index.ts and
// needs the pi-tui runtime graph (openflow-integration.test.ts
// discipline), so the confirm DECISION is factored into the pure
// deleteConfirmStep router tested here directly, and the wiring semantics are pinned by source-parse on
// deleteCurrent/armDelete/executeDelete/handleInput (delete-backfill
// discipline). No test in this file touches the user's real store.

// ---------------------------------------------------------------------------
// Pure modal router: arm → y executes / n·Esc cancels / rest swallowed.
// ---------------------------------------------------------------------------

const ARM = { armed: true, execute: false, cancel: false };
const IDLE = { armed: false, execute: false, cancel: false };
const EXECUTE = { armed: false, execute: true, cancel: false };
const CANCEL = { armed: false, execute: false, cancel: true };

test("the first delete press arms only — nothing executes, nothing cancels", () => {
  assert.deepEqual(deleteConfirmStep(false, true, false, ""), ARM);
});

test("an unarmed non-delete key is a no-op — the confirm stays out of the way", () => {
  assert.deepEqual(deleteConfirmStep(false, false, false, "x"), IDLE);
});

test("while armed, y (and Y) executes the delete", () => {
  assert.deepEqual(deleteConfirmStep(true, false, false, "y"), EXECUTE);
  assert.deepEqual(deleteConfirmStep(true, false, false, "Y"), EXECUTE);
});

test("while armed, n / N / Esc cancel — the confirm disarms without executing", () => {
  assert.deepEqual(deleteConfirmStep(true, false, false, "n"), CANCEL);
  assert.deepEqual(deleteConfirmStep(true, false, false, "N"), CANCEL);
  assert.deepEqual(deleteConfirmStep(true, false, true, "\x1b"), CANCEL);
});

test("while armed, any other key is swallowed and the confirm STAYS armed", () => {
  // Plain typing, digits, empty data, arrow-key bytes, and a SECOND
  // delete-combo press: none of them execute or cancel.
  assert.deepEqual(deleteConfirmStep(true, false, false, "x"), ARM);
  assert.deepEqual(deleteConfirmStep(true, false, false, "1"), ARM);
  assert.deepEqual(deleteConfirmStep(true, false, false, ""), ARM);
  assert.deepEqual(deleteConfirmStep(true, false, false, "\x1b[A"), ARM);
  assert.deepEqual(deleteConfirmStep(true, true, false, "\x1b[27;6~"), ARM);
});

test("full machine: arm → y executes; a fresh arm is needed per delete", () => {
  const armed = deleteConfirmStep(false, true, false, "");
  assert.equal(armed.armed, true);
  assert.equal(armed.execute, false);
  const done = deleteConfirmStep(armed.armed, false, false, "y");
  assert.equal(done.execute, true);
  assert.equal(done.armed, false, "executing leaves the confirm disarmed");
  // After execution the confirm is idle: typing resumes as usual.
  assert.deepEqual(deleteConfirmStep(done.armed, false, false, "x"), IDLE);
});

test("full machine: arm → n cancels → disarmed without executing", () => {
  const armed = deleteConfirmStep(false, true, false, "");
  const cancelled = deleteConfirmStep(armed.armed, false, true, "\x1b");
  assert.equal(cancelled.cancel, true);
  assert.equal(cancelled.armed, false);
  assert.equal(cancelled.execute, false);
});

// The executing press composes with the pure planner: an editor-source
// record deletes from the store AND tombstones; a session-source record is
// read-only — the planner plans NOTHING for it (slice-05 D1).

test("y on an editor row runs the store-delete + tombstone plan", () => {
  const armed = deleteConfirmStep(false, true, false, "");
  const step = deleteConfirmStep(armed.armed, false, false, "y");
  assert.equal(step.execute, true);
  assert.deepEqual(deletionActionsFor("editor"), {
    deleteFromEditorStore: true,
    writeTombstone: true,
  });
});

test("session rows are read-only: the planner plans nothing for them", () => {
  assert.deepEqual(deletionActionsFor("session"), {
    deleteFromEditorStore: false,
    writeTombstone: false,
  });
});

// ---------------------------------------------------------------------------
// Copy: one confirmation line for every row; the failure toasts state
// exactly what state remains.
// ---------------------------------------------------------------------------

test("the confirmation footer is the single y/n line (PR #1393)", () => {
  const text = deleteConfirmFooterText();
  assert.ok(!text.includes("\n"), "the confirmation stays on one line");
  assert.ok(text.includes("Delete this prompt from history (y/n)?"));
  assert.ok(text.includes("Prompt stays in session log"));
});

test("failure toasts state the remaining state exactly (PR #1393)", () => {
  // A thrown store delete aborts before any tombstone: nothing removed.
  assert.equal(
    STORE_DELETE_FAILED_TEXT,
    "Store delete failed; nothing was removed.",
  );
  // Editor-path hide failure: the store row is gone, the prompt may
  // reappear from transcripts.
  assert.equal(
    EDITOR_HIDE_FAILED_TEXT,
    "Deleted from the store, but hiding failed — the prompt may reappear from session transcripts.",
  );
});

// ---------------------------------------------------------------------------
// Source-parse: the wiring inside the selector (the class itself is not
// instantiable under node:test — see the header note).
// ---------------------------------------------------------------------------

const selectorSource = fs.readFileSync(
  fileURLToPath(new URL("../extensions/history/index.ts", import.meta.url)),
  "utf8",
);

/** Slice out a 2-space-indented method body by its exact signature. */
function methodBodyOf(signature: string): string {
  const decl = selectorSource.indexOf(signature);
  assert.ok(decl >= 0, `${signature} should exist`);
  const end = selectorSource.indexOf("\n  }", decl);
  assert.ok(end > decl, `${signature}'s body should close`);
  return selectorSource.slice(decl, end);
}

function deleteCurrentBody(): string {
  return methodBodyOf("private deleteCurrent(): void {");
}

function executeDeleteBody(): string {
  return methodBodyOf("private executeDelete(): void {");
}

function handleInputBody(): string {
  return methodBodyOf("handleInput(data: string): void {");
}

test("deleteCurrent: session rows no-op FIRST — before any arm or mutation", () => {
  const body = deleteCurrentBody();
  const guardAt = body.indexOf('(selected.source ?? "editor") === "session"');
  assert.ok(guardAt >= 0, "the session read-only guard must exist");
  const guardReturnAt = body.indexOf("return;", guardAt);
  assert.ok(guardReturnAt > guardAt, "the session guard must return");
  // The guard precedes the arm/execute split and every mutation helper.
  const armAt = body.indexOf("this.armDelete()");
  const executeAt = body.indexOf("this.executeDelete()");
  assert.ok(armAt > guardAt, "the session guard must precede arming");
  assert.ok(executeAt > guardAt, "the session guard must precede executing");
  // The combo entry stays two-step: unarmed arms, armed executes.
  assert.ok(
    body.includes("if (!this.confirmArmed)"),
    "the unarmed press must arm",
  );
  assert.ok(
    armAt < executeAt,
    "armDelete is the unarmed branch, executeDelete the armed one",
  );
});

test("armDelete only paints: armed + footer + rebuild — never mutates", () => {
  const body = methodBodyOf("private armDelete(): void {");
  assert.ok(body.includes("this.confirmArmed = true;"));
  assert.ok(body.includes("this.refreshDeleteFooter()"));
  assert.ok(body.includes("this.rebuildList()"));
  assert.ok(!body.includes("hidePrompt("), "arming never writes a tombstone");
  assert.ok(
    !body.includes("this.records.splice("),
    "arming never mutates rows",
  );
});

test("executeDelete leaves the armed state before any mutation", () => {
  const body = executeDeleteBody();
  const disarmAt = body.indexOf("this.confirmArmed = false;");
  assert.ok(disarmAt >= 0, "executing must leave the armed state");
  assert.ok(body.includes("this.refreshDeleteFooter()"));
  const actionsAt = body.indexOf("deletionActionsFor(");
  const hideAt = body.indexOf("hidePrompt(");
  const spliceAt = body.indexOf("this.records.splice(");
  assert.ok(
    disarmAt < actionsAt && actionsAt < hideAt && hideAt < spliceAt,
    "disarm → plan → tombstone → splice ordering",
  );
});

test("while armed, handleInput is modal: the router runs FIRST and returns", () => {
  const body = handleInputBody();
  const modalAt = body.indexOf("if (this.confirmArmed) {");
  assert.ok(modalAt >= 0, "the modal branch must exist");
  assert.ok(
    body.includes("deleteConfirmStep("),
    "the armed branch routes through the pure router",
  );
  assert.ok(
    body.includes('matchesKey(data, "ctrl+shift+backspace")') &&
      body.includes('matchesKey(data, "escape")'),
    "the combo and escape matches come from the TUI keymap",
  );
  const executeAt = body.indexOf("this.executeDelete()");
  const cancelAt = body.indexOf("this.disarmDeleteConfirm()");
  assert.ok(executeAt > modalAt, "y must execute inside the modal branch");
  assert.ok(cancelAt > modalAt, "n/Esc must disarm inside the modal branch");
  // Full swallow: the modal branch RETURNS before the dispatch loop and
  // the search fallthrough can see the key — esc cannot close the overlay.
  const modalReturnAt = body.indexOf("return;", modalAt);
  assert.ok(modalReturnAt > modalAt, "the modal branch must return");
  const loopAt = body.indexOf(
    "for (const { match, handler } of this.dispatch) {",
  );
  const fallthroughAt = body.indexOf(
    "if (!handled) this.forwardToSearch(data);",
  );
  assert.ok(loopAt > modalReturnAt, "armed keys never reach dispatch");
  assert.ok(fallthroughAt > modalReturnAt, "armed keys never reach search");
});

test("the old disarm pre-pass is superseded — disarm only on the modal cancel path", () => {
  const body = handleInputBody();
  assert.ok(
    !body.includes('!matchesKey(data, "ctrl+shift+backspace")'),
    "the unconditional disarm pre-pass must be gone",
  );
  const modalAt = body.indexOf("if (this.confirmArmed) {");
  const disarmAt = body.indexOf("this.disarmDeleteConfirm()");
  assert.ok(disarmAt > modalAt, "disarm must sit inside the modal branch");
});

test("Esc while DISARMED still cancels the overlay via the dispatch entry", () => {
  const table = selectorSource.slice(
    selectorSource.indexOf("private readonly dispatch"),
    selectorSource.indexOf("\n  ];"),
  );
  const cancelAt = table.indexOf('kb.matches(_d, "tui.select.cancel")');
  assert.ok(cancelAt >= 0, "the cancel dispatch entry must stay");
  const entry = table.slice(cancelAt, table.indexOf("},", cancelAt));
  assert.ok(
    entry.includes("this.onCancel()"),
    "disarmed esc must still close the overlay",
  );
});

test("a wheel scroll disarms (and never executes) the armed delete", () => {
  const handleMouseAt = selectorSource.indexOf("override handleMouse(");
  assert.ok(handleMouseAt >= 0, "handleMouse should exist");
  const mouseEnd = selectorSource.indexOf("\n  }", handleMouseAt);
  const mouseBody = selectorSource.slice(handleMouseAt, mouseEnd);
  assert.ok(
    mouseBody.indexOf("this.disarmDeleteConfirm()") >= 0,
    "a wheel scroll can move the selection off the armed row — it must disarm",
  );
  assert.ok(
    !mouseBody.includes("this.executeDelete()"),
    "a wheel scroll must never execute the delete",
  );
});

test("the armed state drives the footer copy and the error-colored highlight", () => {
  const footerBody = methodBodyOf("private refreshDeleteFooter(): void {");
  assert.ok(
    footerBody.includes("deleteConfirmFooterText()"),
    "the armed footer uses the single pure copy (no source argument)",
  );
  assert.ok(
    !footerBody.includes("deleteConfirmFooterText" + "(source)"),
    "the footer must not route through a source variant",
  );
  assert.ok(
    footerBody.includes("SELECTOR_FOOTER_HELP"),
    "disarming restores the help line",
  );

  const rebuildBody = methodBodyOf(
    "private rebuildListWithWidth(width: number): void {",
  );
  assert.ok(
    rebuildBody.includes("this.confirmArmed"),
    "the armed state repaints the selected row",
  );
});

// ---------------------------------------------------------------------------
// Capture gate: the opt-in switch stays GENTLE_PI_HISTORY_CAPTURE (#1390).
// ---------------------------------------------------------------------------

// The contributor branch briefly renamed the switch; the rename must not
// ship. Assemble the rejected literal from parts so this file stays
// grep-clean for it.
const renamedSwitch = `GENTLE_PI_HISTORY_${"ENABLE"}`;

test("captureEnabled reads GENTLE_PI_HISTORY_CAPTURE (strict 1/true/on unchanged)", () => {
  const decl = selectorSource.indexOf("export function captureEnabled(");
  assert.ok(decl >= 0, "captureEnabled should exist");
  const end = selectorSource.indexOf("\n}", decl);
  assert.ok(end > decl, "captureEnabled's body should close");
  const body = selectorSource.slice(decl, end);
  assert.ok(
    body.includes("env.GENTLE_PI_HISTORY_CAPTURE"),
    "the shipped switch must be read",
  );
  assert.ok(!body.includes(renamedSwitch), "the rename must not ship");
  assert.ok(
    body.includes('?.trim().toLowerCase()'),
    "whitespace + case normalization unchanged",
  );
  assert.ok(
    body.includes('value === "1" || value === "true" || value === "on"'),
    "strict 1/true/on opt-in unchanged",
  );
});

test("the history extension never mentions the renamed switch", () => {
  assert.equal(selectorSource.includes(renamedSwitch), false);
});

// ---------------------------------------------------------------------------
// Partial sweep failures (PR #1393 adaptation): a store file that could not
// be read or rewritten may still hold a copy, so the delete must say so —
// and still write the tombstone that hides the remaining copies.
// ---------------------------------------------------------------------------

test("storeDeleteFollowUp: a clean sweep proceeds without a notice", () => {
  assert.deepEqual(
    storeDeleteFollowUp({ filesAffected: 1, removed: 2, failed: 0 }),
    { proceed: true },
  );
});

test("storeDeleteFollowUp: nothing removed and nothing failed stops quietly", () => {
  assert.deepEqual(
    storeDeleteFollowUp({ filesAffected: 0, removed: 0, failed: 0 }),
    { proceed: false },
  );
});

test("storeDeleteFollowUp: any failed file proceeds to hide AND surfaces an error", () => {
  for (const removed of [0, 3]) {
    assert.deepEqual(
      storeDeleteFollowUp({ filesAffected: removed > 0 ? 1 : 0, removed, failed: 1 }),
      { proceed: true, notice: STORE_DELETE_PARTIAL_TEXT },
    );
  }
  assert.ok(STORE_DELETE_PARTIAL_TEXT.includes("could not"));
  assert.ok(STORE_DELETE_PARTIAL_TEXT.includes("hidden"));
});

test("executeDelete routes the sweep result through storeDeleteFollowUp before hiding", () => {
  const body = executeDeleteBody();
  const followAt = body.indexOf("storeDeleteFollowUp(");
  const noticeAt = body.indexOf('this.onNotify?.(followUp.notice, "error")');
  const hideAt = body.indexOf("hidePrompt(");
  assert.ok(followAt >= 0, "the sweep result must be interpreted");
  assert.ok(noticeAt > followAt, "a partial failure must surface as an error");
  assert.ok(hideAt > noticeAt, "the tombstone still follows a partial failure");
  assert.equal(
    body.includes("if (removed === 0) return;"),
    false,
    "a zero-removal partial failure must not skip the tombstone",
  );
});
