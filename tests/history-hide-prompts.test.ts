import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hidePrompt, loadHiddenPrompts } from "../extensions/history/hide-prompts.ts";
import {
  deletionActionsFor,
  promptDedupKey,
} from "../extensions/history/selector-helpers.ts";

// Unit WU4 — S4 tombstone write half + deletion planner + deleteCurrent
// branch (spec C4, design §D6/§F). fs-only: the overlay file is read as
// TEXT for the delete-flow pins (command-registration pattern — never
// imported; it pulls the pi-tui runtime graph).

function makeStateDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hide-prompts-${name}-`));
}

function readHideFile(stateDir: string) {
  return JSON.parse(
    fs.readFileSync(path.join(stateDir, "hidden.json"), "utf8"),
  );
}

// T24 — AC-S4-1: hide-key fidelity. Tombstone keys must byte-match the
// Change 2 dedup key for the same text — same imported helper, never a
// re-implementation: the stored file content is compared against
// promptDedupKey's own output with strict equality.
test("T24 (AC-S4-1): hide keys byte-match promptDedupKey across whitespace, case, and >120-char groups", () => {
  const stateDir = makeStateDir("t24");
  // Three normalization groups: internal whitespace runs (space + tab),
  // letter case, and a text longer than the 120-char key prefix.
  const texts = [
    "fix\t the   build",
    "Deploy THE api",
    `${"pad ".repeat(40)}tail beyond one hundred twenty chars`,
  ];
  for (const text of texts) {
    assert.deepEqual(hidePrompt(stateDir, text), { status: "written" });
  }
  const stored = readHideFile(stateDir);
  assert.ok(Array.isArray(stored), "hidden.json must hold a JSON array");
  // Byte-match: the file holds EXACTLY the shared helper's output, sorted.
  assert.deepEqual(stored, texts.map((text) => promptDedupKey(text)).sort());
  // The loaded set agrees.
  const loaded = loadHiddenPrompts(stateDir);
  for (const key of stored) {
    assert.ok(loaded.has(key));
  }
});

// T25 — AC-S4-2: hide persistence and tolerance. Two deletes of the same
// text compact to ONE key; a missing hide file reads as an empty set; reads
// never throw.
test("T25 (AC-S4-2): duplicate hides compact to one key; a missing file reads as empty; reads never throw", () => {
  const stateDir = makeStateDir("t25");
  // Missing file: empty set, no throw (before any write exists).
  assert.equal(loadHiddenPrompts(stateDir).size, 0);
  // Two deletes of the same text — variants differing by case + whitespace
  // runs normalize onto the same key.
  assert.deepEqual(hidePrompt(stateDir, "Same   Text"), { status: "written" });
  assert.deepEqual(hidePrompt(stateDir, "same text"), { status: "written" });
  const stored = readHideFile(stateDir);
  assert.deepEqual(stored, [promptDedupKey("same text")]);
  const loaded = loadHiddenPrompts(stateDir);
  assert.equal(loaded.size, 1);
  assert.ok(loaded.has(promptDedupKey("same text")));
});

// T26 — AC-S4-5: corrupt hidden.json is fail-open (READ half, green since
// WU3) AND the next hide rewrites the file clean as a sorted compact array —
// the rewrite half is the RED seam here.
test("T26 (AC-S4-5): corrupt hidden.json loads as empty and the next hide rewrites it clean", () => {
  const stateDir = makeStateDir("t26");
  fs.writeFileSync(
    path.join(stateDir, "hidden.json"),
    "{corrupt bytes",
    "utf8",
  );
  assert.equal(loadHiddenPrompts(stateDir).size, 0);
  assert.deepEqual(hidePrompt(stateDir, "beta prompt"), { status: "written" });
  // The rewrite landed: clean JSON holding exactly the new key.
  assert.deepEqual(readHideFile(stateDir), [promptDedupKey("beta prompt")]);
  assert.equal(loadHiddenPrompts(stateDir).size, 1);
});

// T27 — AC-S4-3: session delete flow. Planner: tombstone only. The hide
// lands atomically in the state dir (only hidden.json remains — the .tmp
// staging file was renamed into place). Source-parse pins on the
// deleteCurrent branch: the hide call present, the disk delete UNREACHABLE
// from the session path (it sits inside the editor-store guard), splice +
// bookkeeping AFTER the hide, a failed session hide aborts WITHOUT
// splicing, and no raw fs write ever appears in the branch (transcripts are
// never written).
test("T27 (AC-S4-3): session delete — tombstone-only plan, atomic hide, branch hides then splices after", () => {
  assert.deepEqual(deletionActionsFor("session"), {
    deleteFromEditorStore: false,
    writeTombstone: true,
  });

  // fs behavior: the hide writes the shared key; the state dir holds only
  // hidden.json afterwards (no orphaned .tmp staging file).
  const stateDir = makeStateDir("t27");
  assert.deepEqual(hidePrompt(stateDir, "session   row"), {
    status: "written",
  });
  assert.deepEqual(readHideFile(stateDir), [promptDedupKey("session   row")]);
  assert.deepEqual(fs.readdirSync(stateDir).sort(), ["hidden.json"]);

  // Source-parse the deleteCurrent branch in src/index.ts.
  const overlaySource = fs.readFileSync(
    fileURLToPath(new URL("../extensions/history/index.ts", import.meta.url)),
    "utf8",
  );
  const decl = overlaySource.indexOf("private deleteCurrent(");
  assert.ok(decl !== -1, "deleteCurrent must exist");
  const end = overlaySource.indexOf("\n  }", decl);
  assert.ok(end > decl, "deleteCurrent's body must close");
  const body = overlaySource.slice(decl, end);

  const hideAt = body.indexOf("hidePrompt(");
  assert.ok(hideAt !== -1, "the branch must write the tombstone hide");
  const diskDeleteAt = body.indexOf(
    "deleteFromProject(PI_HISTORY_ROOT, CURRENT_CWD, selected.text)",
  );
  assert.ok(
    diskDeleteAt !== -1,
    "the editor branch keeps its exact call shape",
  );
  // The disk delete is unreachable from the session path: it sits INSIDE
  // the editor-store guard (no block closer between guard and call).
  const editorGuardAt = body.indexOf("if (actions.deleteFromEditorStore)");
  assert.ok(
    editorGuardAt !== -1 && editorGuardAt < diskDeleteAt,
    "the disk delete must be guarded by the editor provenance",
  );
  assert.ok(
    !body.slice(editorGuardAt, diskDeleteAt).includes("\n    }"),
    "the disk delete call must sit inside the editor-store guard block",
  );

  // Session path: hide first, then splice + bookkeeping.
  const spliceAt = body.indexOf("this.records.splice(");
  const backfillAt = body.indexOf("loadedCountAfterDelete(");
  assert.ok(
    hideAt < spliceAt && spliceAt < backfillAt,
    "session path: hide, then splice, then the Change 2 bookkeeping",
  );

  // A failed session hide aborts WITHOUT splicing: the hide-error gate
  // precedes the splice and its early return is exclusive to the
  // non-editor path.
  const gateAt = body.indexOf('if (hide.status === "error")');
  assert.ok(
    gateAt !== -1 && gateAt < spliceAt,
    "the hide-error gate must precede the splice",
  );
  const gate = body.slice(gateAt, spliceAt);
  assert.ok(
    gate.includes("if (!actions.deleteFromEditorStore)"),
    "the abort must be conditional on the non-editor path",
  );
  assert.ok(
    gate.includes("return;"),
    "a failed session hide aborts without splicing",
  );

  // Transcript invariant: the branch never writes files directly.
  assert.ok(
    !body.includes("writeFileSync"),
    "no raw writes in the delete branch",
  );
  assert.ok(
    !body.includes("appendFileSync"),
    "no raw appends in the delete branch",
  );
});

// T28 — AC-S4-4: editor delete flow. Planner: disk delete AND tombstone.
// Source-parse pins: the Change 1 call shape stays exact and its status
// gate unchanged; the twin-suppression hide follows the deleted status; in
// the hide-error gate the toast fires and the splice proceeds on the editor
// path (the row is legitimately gone) — only the session path returns.
test("T28 (AC-S4-4): editor delete — exact disk-delete shape, twin suppression after deleted, splice proceeds through hide errors", () => {
  assert.deepEqual(deletionActionsFor("editor"), {
    deleteFromEditorStore: true,
    writeTombstone: true,
  });

  const overlaySource = fs.readFileSync(
    fileURLToPath(new URL("../extensions/history/index.ts", import.meta.url)),
    "utf8",
  );
  const decl = overlaySource.indexOf("private deleteCurrent(");
  assert.ok(decl !== -1, "deleteCurrent must exist");
  const end = overlaySource.indexOf("\n  }", decl);
  assert.ok(end > decl, "deleteCurrent's body must close");
  const body = overlaySource.slice(decl, end);

  // Change 1 shape unchanged: exact call, followed by the existing gate.
  const diskDeleteAt = body.indexOf(
    "deleteFromProject(PI_HISTORY_ROOT, CURRENT_CWD, selected.text)",
  );
  assert.ok(diskDeleteAt !== -1, "the Change 1 call shape must be exact");
  const earlyReturnAt = body.indexOf("if (removed === 0) return;");
  assert.ok(
    earlyReturnAt > diskDeleteAt,
    "the existing status gate must follow the disk delete",
  );

  // Twin suppression: the tombstone write follows the deleted status so the
  // session twin of the same text cannot resurface (R7).
  const hideAt = body.indexOf("hidePrompt(");
  assert.ok(
    hideAt > earlyReturnAt,
    "the twin-suppression hide must follow the deleted status",
  );

  // Error-semantics shape: the hide-error gate toasts, and the ONLY early
  // return inside it sits behind the non-editor guard — the editor row is
  // legitimately gone and splices even when the twin suppression fails.
  const spliceAt = body.indexOf("this.records.splice(");
  const gateAt = body.indexOf('if (hide.status === "error")');
  assert.ok(gateAt !== -1, "hide errors must be gated");
  const gate = body.slice(gateAt, spliceAt);
  assert.ok(
    gate.includes('this.onNotify?.(hide.message, "error")'),
    "a hide error must toast",
  );
  const abortGuardAt = gate.indexOf("if (!actions.deleteFromEditorStore)");
  assert.ok(
    abortGuardAt !== -1,
    "the early return must be exclusive to the session path",
  );
  assert.ok(
    !gate.slice(0, abortGuardAt).includes("return;"),
    "no unconditional abort before the editor/session split — the editor path splices",
  );
});

// WU4c — write-failure path (AC-S4-2 triangulation): a state dir that cannot
// be created (its parent is a regular file) makes the atomic write return
// false, and hidePrompt maps that to the toast-suitable error object —
// never a throw.
test("hide write failure returns the exact error shape for the delete-flow toast", () => {
  const base = makeStateDir("fail");
  const blocker = path.join(base, "blocker");
  fs.writeFileSync(blocker, "regular file", "utf8");
  const stateDir = path.join(blocker, "sealed"); // parent is a file → ENOTDIR
  assert.deepEqual(hidePrompt(stateDir, "kept prompt"), {
    status: "error",
    message: "Could not write the hide file; the prompt may reappear.",
  });
});
