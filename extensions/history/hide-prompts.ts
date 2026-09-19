// SPDX-FileCopyrightText: 2026 ExoPro. Inspired by @jasonish/pi-prompt-history
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.ts";
import { promptDedupKey } from "./selector-helpers.ts";

/** Name of the tombstone file inside the injected state dir (spec C4). */
const HIDE_FILE_NAME = "hidden.json";

/**
 * Result of one tombstone write (spec C4): `written` on a successful atomic
 * write, or an error object carrying a short, toast-suitable reason. Never
 * throws.
 */
export type HideResult =
  | { status: "written" }
  | { status: "error"; message: string };

/**
 * Load the tombstone key set from `stateDir/hidden.json` — the READ half of
 * the hide-file contract (spec C4). Fail-open: a missing, unreadable,
 * corrupt, or wrong-shaped file is an EMPTY set and the call never throws;
 * a corrupt file is rewritten clean by the next hide (the WRITE half,
 * `hidePrompt`, lands in WU4). Keys are `promptDedupKey` strings written by
 * `hidePrompt`; foreign values are ignored, never trusted.
 */
export function loadHiddenPrompts(stateDir: string): Set<string> {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(stateDir, HIDE_FILE_NAME), "utf8");
  } catch {
    return new Set<string>(); // missing or unreadable → empty tombstones
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set<string>(); // corrupt bytes → fail-open empty
  }
  const keys = new Set<string>();
  if (!Array.isArray(parsed)) return keys; // wrong shape → fail-open empty
  for (const item of parsed) {
    if (typeof item === "string" && item !== "") keys.add(item);
  }
  return keys;
}

/**
 * Write the tombstone key for `text` into `stateDir/hidden.json` — the
 * WRITE half of the hide-file contract (spec C4). The key is the shared
 * `promptDedupKey` (byte-match normative with the merge filter — never a
 * re-implementation); the set compacts on write and persists as a SORTED
 * array via the shared atomic tmp+rename writer. Fail-open both ways: a
 * corrupt or missing file reads as empty (this clean rewrite IS the
 * recovery — the corrupt contents are untrustworthy by definition) and any
 * write failure returns an error object for the delete-flow toast; the
 * call never throws.
 */
export function hidePrompt(stateDir: string, text: string): HideResult {
  const keys = loadHiddenPrompts(stateDir);
  keys.add(promptDedupKey(text));
  const written = writeJsonAtomic(
    path.join(stateDir, HIDE_FILE_NAME),
    [...keys].sort(),
  );
  return written
    ? { status: "written" }
    : {
        status: "error",
        message: "Could not write the hide file; the prompt may reappear.",
      };
}
