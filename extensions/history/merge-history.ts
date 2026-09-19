// SPDX-FileCopyrightText: 2026 ExoPro. Inspired by @jasonish/pi-prompt-history
// SPDX-License-Identifier: MIT

import { loadHiddenPrompts } from "./hide-prompts.ts";
import {
  collectSessionEntries,
  loadSessionIndex,
  refreshSessionIndex,
  startBackgroundIndexBuild,
} from "./session-index.ts";
import { promptDedupKey, type PromptEntry } from "./selector-helpers.ts";

/** Options for the combined editor+session loader (spec C3). */
export interface MergeHistoryOptions {
  /** Editor-store entries in file order (newest-known-first), pre-dedup. */
  editorEntries: readonly string[];
  /** pi-history-nav state dir holding prompt-index.json and hidden.json. */
  stateDir: string;
  /** pi sessions root scanned one level deep for session transcripts. */
  sessionsRoot: string;
  /** Sync rescan budget; above it the refresh defers to the background build. */
  syncChangedFileLimit?: number;
  /** Progress sink for the background build (p/t), wired to the header suffix. */
  onIndexProgress?: (processed: number, total: number) => void;
}

/**
 * THE combined loader (spec C3, design §E): editor block first in input
 * order, then the session-derived block newest-first by ts. The tombstone
 * pre-filter scopes the SESSION half only — after index load, before merge —
 * so the editor store governs itself. No cross-block time interleaving is
 * attempted (accepted R8 seam). Returns the PRE-dedup combined array: the
 * Change 2 keep-first dedup stays with the caller (openHistorySelector), so
 * dedupePromptEntries over this output makes the editor copy win at the
 * seam. Cold start (missing or corrupt index) and a DEFERRED mass-change
 * refresh (WU2b seam, design §D7) both hand the rescan to the chunked
 * background build — never awaited here; onIndexProgress rides along. Every
 * underlying module is fail-open, so this call never throws.
 */
export function mergeHistoryEntries(
  options: MergeHistoryOptions,
): PromptEntry[] {
  const editorBlock: PromptEntry[] = options.editorEntries.map((text) => ({
    text,
    source: "editor",
  }));

  const loaded = loadSessionIndex(options.stateDir);
  if (loaded === null) {
    // Cold start (§D8): the build runs behind this open — the session half
    // is empty THIS open; the fruits appear from the next one.
    startBackgroundIndexBuild({
      stateDir: options.stateDir,
      sessionsRoot: options.sessionsRoot,
      onProgress: options.onIndexProgress,
    });
    return editorBlock;
  }

  const refresh = refreshSessionIndex({
    sessionsRoot: options.sessionsRoot,
    index: loaded,
    stateDir: options.stateDir,
    syncChangedFileLimit: options.syncChangedFileLimit,
  });
  if (refresh.deferred) {
    // Mass-change (§D7): the stale index was served this open; the chunked
    // background build owns the rescan, progress wired through.
    startBackgroundIndexBuild({
      stateDir: options.stateDir,
      sessionsRoot: options.sessionsRoot,
      onProgress: options.onIndexProgress,
    });
  }

  const hidden = loadHiddenPrompts(options.stateDir);
  const sessionBlock: PromptEntry[] = collectSessionEntries(refresh.index)
    .filter((entry) => !hidden.has(promptDedupKey(entry.text)))
    .map((entry) => ({ text: entry.text, source: "session", ts: entry.ts }));

  return [...editorBlock, ...sessionBlock];
}
