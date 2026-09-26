// SPDX-FileCopyrightText: 2026 ExoPro. Inspired by @jasonish/pi-prompt-history
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.ts";
import { promptDedupKey } from "./selector-helpers.ts";

/** Name of the tombstone file inside the injected state dir (spec C4). */
const HIDE_FILE_NAME = "hidden.json";

/** Marks tombstone entries written in the exact (hashed) key format. */
const TOMBSTONE_KEY_PREFIX = "sha256:";

/**
 * UI-level prompt identity: whitespace-collapsed, trimmed, case-insensitive,
 * never truncated. The store's scope deletes sweep by this same identity,
 * so a tombstone hides exactly the copies a delete removes.
 */
export function promptIdentity(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Tombstone key for `text`: a SHA-256 of its full prompt identity. Exact —
 * two prompts that merely share a prefix get different keys — and hashed,
 * so hidden.json never holds the text of a deleted prompt.
 */
export function tombstoneKey(text: string): string {
  return (
    TOMBSTONE_KEY_PREFIX +
    createHash("sha256").update(promptIdentity(text)).digest("hex")
  );
}

/**
 * Whether `text` is hidden by the tombstone set `keys`. Hashed keys match
 * the exact prompt identity. Plaintext entries from the earlier prefix
 * format (`promptDedupKey`: the first 120 normalized characters) stay
 * honored as written, so upgrading never resurfaces a hidden prompt; only
 * new deletions use the exact format.
 */
export function isPromptHidden(keys: ReadonlySet<string>, text: string): boolean {
  if (keys.size === 0) return false;
  return keys.has(tombstoneKey(text)) || keys.has(promptDedupKey(text));
}

/**
 * Retention cap for hidden.json (slice-05 D5): the tombstone file is a
 * rebuildable derived cache, not a retention guarantee, so it holds at
 * most this many keys in recency order; hiding past the cap drops the
 * OLDEST keys from the front.
 */
export const HIDE_FILE_MAX_ENTRIES = 1000;

/**
 * Shared recovery warning for a file that exists but cannot be trusted
 * (spec C4, fail-closed READ half): toast-suitable, names hidden.json, and
 * gives the user the explicit restore-or-delete choice.
 */
const RECOVERY_MESSAGE =
  "The prompt-history hide list (hidden.json) is corrupt or unreadable. History is blocked until you restore the file or delete it (hidden prompts may then reappear).";

/**
 * Result of one tombstone write (spec C4): `written` on a successful atomic
 * write, or an error object carrying a short, toast-suitable reason. Never
 * throws.
 */
export type HideResult =
  | { status: "written" }
  | { status: "error"; message: string };

/**
 * Result of one tombstone read (spec C4): `trusted` keys when the file is
 * missing or holds a valid array, or `untrusted` when the file exists but
 * cannot be trusted. History reads FAIL CLOSED on `untrusted`: callers must
 * block the drain instead of emptying the tombstone set, because hidden
 * prompts may contain secrets an empty set would resurface.
 */
export type HiddenRead =
  | { status: "trusted"; keys: Set<string> }
  | {
      status: "untrusted";
      reason: "unreadable" | "corrupt" | "malformed";
      message: string;
    };

/**
 * Read the tombstone key set from `stateDir/hidden.json` — the READ half of
 * the hide-file contract (spec C4). Fail-closed for history: a file that
 * exists but is unreadable, corrupt, or wrong-shaped returns `untrusted`
 * with the recovery warning so callers block the drain; it never degrades
 * to an empty trusted set. A MISSING file — before any deletion — is the
 * safe empty case and reads `trusted` with no keys. A valid array is
 * trusted; junk items inside it are ignored, never trusted. Keys are the
 * `tombstoneKey` hashes written by `hidePrompt`, or plaintext entries from
 * the earlier prefix format (see `isPromptHidden`); the call never throws.
 * A valid array's stored order is preserved (the recency order — oldest
 * first — that `hidePrompt` maintains and caps).
 */
export function readHiddenPrompts(stateDir: string): HiddenRead {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(stateDir, HIDE_FILE_NAME), "utf8");
  } catch (error) {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (code === "ENOENT") {
      // Missing before any deletion: the safe empty tombstone set.
      return { status: "trusted", keys: new Set<string>() };
    }
    return {
      status: "untrusted",
      reason: "unreadable",
      message: RECOVERY_MESSAGE,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "untrusted", reason: "corrupt", message: RECOVERY_MESSAGE };
  }
  const keys = new Set<string>();
  if (!Array.isArray(parsed)) {
    return {
      status: "untrusted",
      reason: "malformed",
      message: RECOVERY_MESSAGE,
    };
  }
  for (const item of parsed) {
    if (typeof item === "string" && item !== "") keys.add(item);
  }
  return { status: "trusted", keys };
}

/**
 * Write the tombstone key for `text` into `stateDir/hidden.json` — the
 * WRITE half of the hide-file contract (spec C4). The key is the shared
 * `tombstoneKey` (byte-match normative with the drain and seed filters via
 * `isPromptHidden` — never a re-implementation). The file array is RECENCY-ordered — oldest key
 * first, newest key appended last — and re-hiding an existing key
 * refreshes it to the end (delete + add, since Set.add on a present
 * member keeps its old position). The file is capped at
 * `HIDE_FILE_MAX_ENTRIES` (1000): after the append, keys drop from the
 * FRONT until the file fits, so hidden.json stays a bounded cache — a
 * dropped (oldest) prompt may reappear in the list and can be deleted
 * again. Keys persist in that insertion order — NO sort — via the shared
 * atomic tmp+rename writer. An untrusted existing file is never silently
 * reset (a clean rewrite would clear the blocked state one hide later):
 * hidePrompt refuses with the recovery warning until the user restores or
 * deletes the file. A missing file is the clean baseline; any write
 * failure returns an error object for the delete-flow toast; the call
 * never throws.
 */
export function hidePrompt(stateDir: string, text: string): HideResult {
  const read = readHiddenPrompts(stateDir);
  if (read.status === "untrusted") {
    // Refuse without writing: never reset the untrusted state silently.
    return { status: "error", message: read.message };
  }
  // Recency order (slice-05 D5): the set iterates in stored file order
  // (oldest first); delete+add refreshes a re-hidden key to the END.
  const key = tombstoneKey(text);
  read.keys.delete(key);
  read.keys.add(key);
  // Cap: drop the OLDEST keys from the front once over the limit.
  const ordered = [...read.keys];
  if (ordered.length > HIDE_FILE_MAX_ENTRIES) {
    ordered.splice(0, ordered.length - HIDE_FILE_MAX_ENTRIES);
  }
  const written = writeJsonAtomic(
    path.join(stateDir, HIDE_FILE_NAME),
    ordered,
  );
  return written
    ? { status: "written" }
    : {
        status: "error",
        message: "Could not write the hide file; the prompt may reappear.",
      };
}
