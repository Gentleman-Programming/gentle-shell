import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessionFiles } from "../extensions/history/session-scan.ts";

/**
 * WU1b-carried T7 (AC-S1-7): the one-level directory exclusion matrix. The
 * fixture tree mirrors the pi sessions root — encoded-cwd directories with
 * top-level jsonl session files, nested run-N/session.jsonl subagent
 * payloads, a subagent-artifacts subtree, and a stray root-level file.
 * Fixture files carry garbage content: the scanner must LIST paths only, so
 * exact path equality proves nested payloads are never ingested (a
 * recursive scanner would emit them).
 */
function makeSessionsRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-scan-dirs-"));
}

function writeFileAt(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "garbage-not-json\n", "utf8");
}

test("one-level scan rule: only top-level jsonl of cwd dirs; nested payloads, subagent-artifacts, and stray root files never ingested (AC-S1-7)", () => {
  const root = makeSessionsRoot();

  // two cwd directories, each holding top-level jsonl session files
  const cwdA = path.join(root, "--home-user-project-a--");
  const cwdB = path.join(root, "--home-user-project-b--");
  writeFileAt(path.join(cwdA, "2026-01-01t10-00-00aaa.jsonl"));
  writeFileAt(path.join(cwdA, "2026-01-02t11-00-00bbb.jsonl"));
  writeFileAt(path.join(cwdB, "2026-01-03t12-00-00ccc.jsonl"));

  // nested run-N/session.jsonl subagent payloads — never descended
  writeFileAt(path.join(cwdA, "run-1", "session.jsonl"));
  writeFileAt(path.join(cwdB, "run-2", "session.jsonl"));

  // a subagent-artifacts subtree holding a jsonl file — never descended
  writeFileAt(path.join(cwdA, "subagent-artifacts", "artifact.jsonl"));

  // one stray root-level FILE (not a directory) — skipped
  writeFileAt(path.join(root, "stray.jsonl"));

  const files = listSessionFiles(root);

  // exactly the three top-level jsonl paths of the cwd directories,
  // sorted, absolute
  assert.deepEqual(files, [
    path.join(cwdA, "2026-01-01t10-00-00aaa.jsonl"),
    path.join(cwdA, "2026-01-02t11-00-00bbb.jsonl"),
    path.join(cwdB, "2026-01-03t12-00-00ccc.jsonl"),
  ]);
  for (const file of files) {
    assert.equal(path.isAbsolute(file), true);
  }
});

// node:test has no test.skipIf (Bun-ism): root skips via the options
// object — chmod 000 is invisible to the superuser.
const sealedDirTest = (name: string, fn: () => void) =>
  test(
    name,
    { skip: process.getuid?.() === 0 ? "requires non-root" : false },
    fn,
  );
sealedDirTest(
  "an unreadable child dir (chmod 000) is skipped; sibling dirs still list",
  () => {
    const root = makeSessionsRoot();
    const sealed = path.join(root, "--sealed--");
    const open = path.join(root, "--open--");
    writeFileAt(path.join(sealed, "hidden-session.jsonl"));
    writeFileAt(path.join(open, "visible-session.jsonl"));
    fs.chmodSync(sealed, 0o000);
    try {
      // One directory whose readdir fails skips itself — never fatal — and
      // the sibling directories still contribute their files.
      assert.deepEqual(listSessionFiles(root), [
        path.join(open, "visible-session.jsonl"),
      ]);
    } finally {
      fs.chmodSync(sealed, 0o755); // restore before cleanup
    }
  },
);
