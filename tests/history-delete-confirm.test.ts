import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deleteConfirmFooterText,
  deleteConfirmNext,
  deletionActionsFor,
  EDITOR_HIDE_FAILED_TEXT,
  STORE_DELETE_FAILED_TEXT,
} from "../extensions/history/selector-helpers.ts";

// PR #1393 review-fix tests: the two-step delete confirmation in the
// history selector. The first ctrl+shift+backspace press ARMS the delete
// for the selected row (scope-aware confirmation footer + highlighted
// record) and executes NOTHING; the second press executes the
// deletionActionsFor-driven flow; any other key or cancel disarms.
//
// PromptHistorySelector is private to extensions/history/index.ts and
// needs the pi-tui runtime graph (openflow-integration.test.ts
// discipline), and an executing delete writes the module-constant REAL
// store (~/.pi/agent/history — no injection point), so the confirmation
// DECISION is factored into pure helpers tested here directly, and the
// execution semantics are pinned by source-parse on deleteCurrent
// (delete-backfill.test.ts discipline). No test in this file touches the
// user's real store.

// ---------------------------------------------------------------------------
// Pure decision machine: arm → execute, disarm on anything else.
// ---------------------------------------------------------------------------

test("the first delete press arms only — nothing executes (PR #1393)", () => {
  assert.deepEqual(deleteConfirmNext(false, true), {
    armed: true,
    execute: false,
  });
});

test("the second delete press executes and rearms-to-idle (PR #1393)", () => {
  assert.deepEqual(deleteConfirmNext(true, true), {
    armed: false,
    execute: true,
  });
});

test("any other key disarms without executing; an idle stay stays idle", () => {
  assert.deepEqual(deleteConfirmNext(true, false), {
    armed: false,
    execute: false,
  });
  assert.deepEqual(deleteConfirmNext(false, false), {
    armed: false,
    execute: false,
  });
});

test("after an executed delete the machine is idle again — a fresh confirm per row", () => {
  const first = deleteConfirmNext(false, true);
  assert.equal(first.execute, false);
  const second = deleteConfirmNext(first.armed, true);
  assert.equal(second.execute, true);
  // A THIRD press starts a NEW confirmation instead of executing blindly.
  assert.deepEqual(deleteConfirmNext(second.armed, true), {
    armed: true,
    execute: false,
  });
});

// (b) + (c): the executing press composes with the pure planner — an
// editor-source record deletes from the store AND tombstones; a
// session-source record NEVER plans a store delete (tombstone only).

test("second press executes the editor-source plan: store delete + tombstone", () => {
  const armed = deleteConfirmNext(false, true);
  const step = deleteConfirmNext(armed.armed, true);
  assert.equal(step.execute, true);
  assert.deepEqual(deletionActionsFor("editor"), {
    deleteFromEditorStore: true,
    writeTombstone: true,
  });
});

test("a session-source record never plans a store delete — tombstone only", () => {
  const armed = deleteConfirmNext(false, true);
  const step = deleteConfirmNext(armed.armed, true);
  assert.equal(step.execute, true);
  const actions = deletionActionsFor("session");
  assert.equal(actions.deleteFromEditorStore, false);
  assert.equal(actions.writeTombstone, true);
});

// ---------------------------------------------------------------------------
// Copy: the armed footer distinguishes the two semantics in one line; the
// failure toasts state exactly what state remains.
// ---------------------------------------------------------------------------

test("the editor confirmation names the physical delete AND the hide", () => {
  const text = deleteConfirmFooterText("editor");
  assert.ok(!text.includes("\n"), "the confirmation stays on one line");
  assert.ok(text.includes("Delete stored prompt?"));
  assert.ok(text.includes("Removes every copy from the store"));
  assert.ok(text.includes("hides it from history"));
  assert.ok(
    text.includes("Session transcripts keep the original"),
    "the immutability caveat must be stated",
  );
});

test("the session confirmation names the hide-only semantics", () => {
  const text = deleteConfirmFooterText("session");
  assert.ok(!text.includes("\n"), "the confirmation stays on one line");
  assert.ok(text.includes("Hide from history?"));
  assert.ok(text.includes("The original stays in the session transcript"));
  assert.ok(text.includes("tombstone keeps it out of this list"));
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
// Source-parse: the execution semantics inside deleteCurrent (the selector
// class itself is not instantiable under node:test — see the header note).
// ---------------------------------------------------------------------------

const selectorSource = fs.readFileSync(
  fileURLToPath(new URL("../extensions/history/index.ts", import.meta.url)),
  "utf8",
);

function deleteCurrentBody(): string {
  const decl = selectorSource.indexOf("private deleteCurrent(");
  assert.ok(decl >= 0, "deleteCurrent should exist");
  const end = selectorSource.indexOf("\n  }", decl);
  assert.ok(end > decl, "deleteCurrent's body should close");
  return selectorSource.slice(decl, end);
}

test("(b) the arming press returns before ANY mutation of rows or disk", () => {
  const body = deleteCurrentBody();
  const stepAt = body.indexOf("const step = deleteConfirmNext(this.confirmArmed, true);");
  assert.ok(stepAt >= 0, "the transition must route through the pure helper");
  const armReturnAt = body.indexOf("if (!step.execute)");
  assert.ok(armReturnAt > stepAt, "the execute gate must follow the step");
  const editorGuardAt = body.indexOf("if (actions.deleteFromEditorStore)");
  const spliceAt = body.indexOf("this.records.splice(");
  const hideAt = body.indexOf("hidePrompt(");
  assert.ok(
    armReturnAt < editorGuardAt &&
      armReturnAt < spliceAt &&
      armReturnAt < hideAt,
    "arming must precede the store flow, the splice, and the tombstone",
  );
});

test("(c) the store deletes live only inside the editor-source guard", () => {
  const body = deleteCurrentBody();
  const guardAt = body.indexOf("if (actions.deleteFromEditorStore)");
  assert.ok(guardAt >= 0, "the editor-store guard must exist");
  const guardCloseAt = body.indexOf("\n    }", guardAt);
  assert.ok(guardCloseAt > guardAt, "the editor-store guard must close");

  for (const call of ["deleteFromGlobal(", "deleteFromProject("]) {
    const at = body.indexOf(call);
    assert.ok(at >= 0, `${call} must exist`);
    assert.ok(
      at > guardAt && at < guardCloseAt,
      `${call} must sit inside the editor guard — a session record never reaches it`,
    );
  }
  // The tombstone write follows the guard: EVERY provenance lands one.
  const hideAt = body.indexOf("hidePrompt(");
  assert.ok(
    hideAt > guardCloseAt,
    "the tombstone must follow (not sit inside) the editor-store guard",
  );
});

test("(d) a thrown store delete toasts the failure copy and aborts", () => {
  const body = deleteCurrentBody();
  const tryAt = body.indexOf("try {");
  const catchAt = body.indexOf("} catch {", tryAt);
  assert.ok(tryAt >= 0 && catchAt > tryAt, "the store calls must be wrapped");
  const catchEnd = body.indexOf("\n      }", catchAt);
  const catchBody = body.slice(catchAt, catchEnd);
  assert.ok(
    catchBody.includes(`this.onNotify?.(STORE_DELETE_FAILED_TEXT, "error")`),
    "the catch must toast the store-failure copy",
  );
  assert.ok(
    catchBody.includes("return;"),
    "the catch must abort the flow",
  );
  // The abort precedes the tombstone write: a failed store delete leaves
  // NO tombstone behind.
  const hideAt = body.indexOf("hidePrompt(");
  assert.ok(catchAt < hideAt, "the catch must precede the hide write");
});

test("(e) a hide error toasts the session message and aborts — the editor path proceeds to the splice", () => {
  const body = deleteCurrentBody();
  const gateAt = body.indexOf('if (hide.status === "error")');
  assert.ok(gateAt >= 0, "hide errors must be gated");
  const spliceAt = body.indexOf("this.records.splice(");
  assert.ok(gateAt < spliceAt, "the hide gate must precede the splice");
  const gate = body.slice(gateAt, spliceAt);

  // Session path: toast the recovery message and abort.
  const abortGuardAt = gate.indexOf("if (!actions.deleteFromEditorStore)");
  assert.ok(
    abortGuardAt >= 0,
    "the session-path early return must be exclusive",
  );
  const abortBody = gate.slice(abortGuardAt, gate.indexOf("}", abortGuardAt));
  assert.ok(
    abortBody.includes('this.onNotify?.(hide.message, "error")'),
    "the session path must toast the hide error itself",
  );
  assert.ok(abortBody.includes("return;"), "the session path must abort");
  assert.ok(
    !gate.slice(0, abortGuardAt).includes("return;"),
    "no unconditional abort before the provenance split",
  );

  // Editor path: the store row is already gone — the toast says so, and
  // control FALLS THROUGH to the splice (no return between the toast and
  // the splice).
  const editorToastAt = gate.indexOf(`this.onNotify?.(EDITOR_HIDE_FAILED_TEXT, "error")`);
  assert.ok(editorToastAt >= 0, "the editor path must toast the hide failure");
  const gateToSplice = gate.slice(editorToastAt);
  assert.ok(
    !gateToSplice.includes("return;"),
    "the editor path must NOT abort — the splice still runs",
  );
});

test("any other key disarms before its own action; a wheel scroll disarms too", () => {
  const handleInputAt = selectorSource.indexOf("handleInput(data: string): void {");
  assert.ok(handleInputAt >= 0, "handleInput should exist");
  const inputEnd = selectorSource.indexOf("\n  }", handleInputAt);
  const inputBody = selectorSource.slice(handleInputAt, inputEnd);
  const disarmAt = inputBody.indexOf("this.disarmDeleteConfirm()");
  assert.ok(disarmAt >= 0, "handleInput must disarm a pending confirmation");
  assert.ok(
    inputBody.includes('!matchesKey(data, "ctrl+shift+backspace")'),
    "the delete combo itself must NOT route through the disarm pre-pass",
  );
  // The disarm must happen before the dispatch loop consumes the key.
  const loopAt = inputBody.indexOf("for (const { match, handler } of this.dispatch) {");
  assert.ok(disarmAt < loopAt, "the disarm pre-pass must precede dispatch");

  const handleMouseAt = selectorSource.indexOf("override handleMouse(");
  assert.ok(handleMouseAt >= 0, "handleMouse should exist");
  const mouseEnd = selectorSource.indexOf("\n  }", handleMouseAt);
  const mouseBody = selectorSource.slice(handleMouseAt, mouseEnd);
  assert.ok(
    mouseBody.indexOf("this.disarmDeleteConfirm()") >= 0,
    "a wheel scroll can move the selection off the armed row — it must disarm",
  );
});

test("the armed state drives the footer copy and the error-colored highlight", () => {
  const body = deleteCurrentBody();
  assert.ok(
    body.includes("this.refreshDeleteFooter()"),
    "every delete press refreshes the footer",
  );

  const footerAt = selectorSource.indexOf("private refreshDeleteFooter(): void {");
  assert.ok(footerAt >= 0, "refreshDeleteFooter should exist");
  const footerEnd = selectorSource.indexOf("\n  }", footerAt);
  const footerBody = selectorSource.slice(footerAt, footerEnd);
  assert.ok(
    footerBody.includes("deleteConfirmFooterText(source)"),
    "the armed footer uses the scope-aware pure copy",
  );
  assert.ok(
    footerBody.includes("SELECTOR_FOOTER_HELP"),
    "disarming restores the help line",
  );

  const rebuildAt = selectorSource.indexOf("private rebuildListWithWidth(width: number): void {");
  assert.ok(rebuildAt >= 0, "rebuildListWithWidth should exist");
  const rebuildEnd = selectorSource.indexOf("\n  }", rebuildAt);
  const rebuildBody = selectorSource.slice(rebuildAt, rebuildEnd);
  assert.ok(
    rebuildBody.includes("this.confirmArmed"),
    "the armed state repaints the selected row",
  );
});
