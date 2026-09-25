import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hidePrompt,
  readHiddenPrompts,
} from "../extensions/history/hide-prompts.ts";
import { promptDedupKey } from "../extensions/history/selector-helpers.ts";

// Unit WU4 — tombstone write half + read half (spec C4, design §D6). fs-only
// coverage. The READ half FAILS CLOSED for history: a file that exists but
// cannot be trusted (unreadable, corrupt, wrong shape) reads `untrusted`
// with a recovery warning instead of an empty tombstone set, and the WRITE
// half refuses without a silent rewrite. The dev suite's deleteCurrent
// source-parse pins (T27/T28) and the deletionActionsFor planner pins cover
// the slice-3 selector branch and the slice-5 delete flow; they port with
// those slices.

function makeStateDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hide-prompts-${name}-`));
}

function readHideFile(stateDir: string) {
  return JSON.parse(
    fs.readFileSync(path.join(stateDir, "hidden.json"), "utf8"),
  );
}

/** Assert an untrusted read of the expected reason; returns its message. */
function assertUntrusted(
  stateDir: string,
  reason: "unreadable" | "corrupt" | "malformed",
): string {
  const read = readHiddenPrompts(stateDir);
  assert.equal(read.status, "untrusted");
  if (read.status !== "untrusted") throw new Error("unreachable");
  assert.equal(read.reason, reason);
  // The recovery warning names the file and offers restore-or-delete.
  assert.ok(read.message.includes("hidden.json"));
  assert.ok(/restore|delete/.test(read.message));
  return read.message;
}

/** Assert a trusted read and return its key set. */
function trustedKeys(stateDir: string): Set<string> {
  const read = readHiddenPrompts(stateDir);
  assert.equal(read.status, "trusted");
  if (read.status !== "trusted") throw new Error("unreachable");
  return read.keys;
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
  // The read half agrees.
  const keys = trustedKeys(stateDir);
  assert.equal(keys.size, stored.length);
  for (const key of stored) {
    assert.ok(keys.has(key));
  }
});

// T25 — AC-S4-2: hide persistence and tolerance. Two deletes of the same
// text compact to ONE key; a MISSING hide file (before any deletion) is the
// safe empty case — trusted with no keys; reads never throw.
test("T25 (AC-S4-2): duplicate hides compact to one key; a missing file reads trusted-empty; reads never throw", () => {
  const stateDir = makeStateDir("t25");
  // Missing file: trusted empty tombstones (before any write exists).
  assert.equal(trustedKeys(stateDir).size, 0);
  // Two deletes of the same text — variants differing by case + whitespace
  // runs normalize onto the same key.
  assert.deepEqual(hidePrompt(stateDir, "Same   Text"), { status: "written" });
  assert.deepEqual(hidePrompt(stateDir, "same text"), { status: "written" });
  const stored = readHideFile(stateDir);
  assert.deepEqual(stored, [promptDedupKey("same text")]);
  const keys = trustedKeys(stateDir);
  assert.equal(keys.size, 1);
  assert.ok(keys.has(promptDedupKey("same text")));
});

// T26 — AC-S4-5: corrupt hidden.json FAILS CLOSED for history reads. The
// READ half reports untrusted (corrupt) so callers block history instead of
// resurfacing hidden prompts; the WRITE half refuses WITHOUT a silent clean
// rewrite (the old fail-open behavior cleared the blocked state one hide
// later). Recovery is manual — restore or delete the file; after deletion
// the next hide succeeds and reads are trusted again.
test("T26 (AC-S4-5): corrupt hidden.json reads untrusted; hide refuses without rewriting; deleting the file recovers", () => {
  const stateDir = makeStateDir("t26");
  const hidePath = path.join(stateDir, "hidden.json");
  fs.writeFileSync(hidePath, "{corrupt bytes", "utf8");
  // READ half: untrusted/corrupt — never an empty trusted set.
  const message = assertUntrusted(stateDir, "corrupt");
  // WRITE half: refused, and the corrupt bytes are UNCHANGED — the blocked
  // state is never silently reset (no-silent-rewrite pin).
  const before = fs.readFileSync(hidePath, "utf8");
  assert.deepEqual(hidePrompt(stateDir, "beta prompt"), {
    status: "error",
    message,
  });
  assert.equal(fs.readFileSync(hidePath, "utf8"), before);
  // Manual recovery: delete the file; the next hide succeeds and reads are
  // trusted with exactly the new key.
  fs.unlinkSync(hidePath);
  assert.deepEqual(hidePrompt(stateDir, "beta prompt"), { status: "written" });
  const keys = trustedKeys(stateDir);
  assert.equal(keys.size, 1);
  assert.ok(keys.has(promptDedupKey("beta prompt")));
});

// Wrong-shaped file: valid JSON that is not an array fails closed too (both
// halves), while junk items inside a VALID array are ignored and the real
// keys stay trusted.
test("malformed hidden.json fails closed for reads and writes; junk items in a valid array are ignored", () => {
  const malformed = makeStateDir("malformed");
  const hidePath = path.join(malformed, "hidden.json");
  for (const shape of ["{}", JSON.stringify({ keys: [] })]) {
    fs.writeFileSync(hidePath, shape, "utf8");
    assertUntrusted(malformed, "malformed");
  }
  // The write half refuses the malformed file as well.
  const message = assertUntrusted(malformed, "malformed");
  assert.deepEqual(hidePrompt(malformed, "kept prompt"), {
    status: "error",
    message,
  });

  // Junk items are ignored, never trusted; real keys survive.
  const junk = makeStateDir("junk");
  fs.writeFileSync(
    path.join(junk, "hidden.json"),
    JSON.stringify([42, "", "real-key", null]),
    "utf8",
  );
  const keys = trustedKeys(junk);
  assert.equal(keys.size, 1);
  assert.ok(keys.has("real-key"));
});

// Unreadable file: a hidden.json that cannot be read at all fails closed
// for reads, and the write half refuses too. Skipped as root, where chmod
// 000 does not block reads; permissions are restored in finally.
test(
  "an unreadable hidden.json fails closed for reads and refuses writes",
  { skip: process.getuid?.() === 0 },
  () => {
    const stateDir = makeStateDir("sealed");
    const hidePath = path.join(stateDir, "hidden.json");
    fs.writeFileSync(hidePath, '["kept-key"]', "utf8");
    fs.chmodSync(hidePath, 0o000);
    try {
      const message = assertUntrusted(stateDir, "unreadable");
      assert.deepEqual(hidePrompt(stateDir, "beta prompt"), {
        status: "error",
        message,
      });
    } finally {
      fs.chmodSync(hidePath, 0o644); // restore before cleanup
    }
  },
);

// WU4c — write-failure path (AC-S4-2 triangulation): a trusted read whose
// atomic write fails makes hidePrompt return the toast-suitable error
// object — never a throw. The state dir is made non-writable while the
// existing hidden.json stays readable (a state dir whose PATH is blocked
// by a regular file is now the untrusted-refusal case instead — the READ
// half fails closed before any write). Skipped as root, where chmod-based
// write blocking does not apply; permissions are restored in finally.
test(
  "hide write failure returns the exact error shape for the delete-flow toast",
  { skip: process.getuid?.() === 0 },
  () => {
    const stateDir = makeStateDir("fail");
    fs.writeFileSync(
      path.join(stateDir, "hidden.json"),
      '["kept-key"]',
      "utf8",
    );
    fs.chmodSync(stateDir, 0o555); // read+execute, no write → EACCES on tmp
    try {
      assert.deepEqual(hidePrompt(stateDir, "kept prompt"), {
        status: "error",
        message: "Could not write the hide file; the prompt may reappear.",
      });
    } finally {
      fs.chmodSync(stateDir, 0o700); // restore before cleanup
    }
  },
);
