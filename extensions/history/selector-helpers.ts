export interface PromptRecord {
  text: string;
  searchText: string;
  /**
   * Provenance (spec C3): set on records built from PromptEntry inputs;
   * ABSENT on records built from bare strings so the pinned deepEqual
   * record shape ({text, searchText}) stays byte-compatible (design §I).
   */
  source?: PromptSource;
  /** Session records only: the resolved ms-epoch ordering timestamp. */
  ts?: number;
}

/** Provenance of a prompt record or merge-loader entry (spec C3). */
export type PromptSource = "editor" | "session";

/**
 * Merge-loader currency (pre-dedup, spec C3): one editor-store or
 * session-derived prompt. Session entries carry the resolved ms-epoch `ts`;
 * editor entries do not (block ordering at the seam, proposal R8).
 */
export interface PromptEntry {
  text: string;
  source: PromptSource;
  ts?: number;
}

export interface VisibleRange {
  start: number;
  end: number;
}

export interface VisiblePromptRecord {
  index: number;
  record: PromptRecord;
  isSelected: boolean;
}

export interface PiHistoryGlobals {
  __piHistoryExpand?: () => void;
  __piHistoryTrim?: () => void;
}

export function buildPromptRecords(
  entries: ReadonlyArray<string | PromptEntry>,
): PromptRecord[] {
  return entries.map((entry): PromptRecord => {
    if (typeof entry === "string") {
      // Bare string input keeps the EXACT Change 2 runtime shape — the
      // pinned deepEqual records carry only {text, searchText}.
      return { text: entry, searchText: entry.toLowerCase() };
    }
    const record: PromptRecord = {
      text: entry.text,
      searchText: entry.text.toLowerCase(),
      source: entry.source,
    };
    if (entry.ts !== undefined) {
      record.ts = entry.ts;
    }
    return record;
  });
}

export function clampSelectedIndex(
  selectedIndex: number,
  total: number,
): number {
  return Math.max(0, Math.min(selectedIndex, Math.max(0, total - 1)));
}

export function clampPreviewOffset(
  offset: number,
  totalLines: number,
  viewportRows: number,
): number {
  return Math.max(0, Math.min(offset, Math.max(0, totalLines - viewportRows)));
}

export function computeVisibleRange(
  selectedIndex: number,
  total: number,
  maxVisible: number,
): VisibleRange {
  if (total <= 0 || maxVisible <= 0) return { start: 0, end: 0 };
  if (total <= maxVisible) return { start: 0, end: total };

  const half = Math.floor(maxVisible / 2);
  const start = Math.max(0, Math.min(selectedIndex - half, total - maxVisible));

  return {
    start,
    end: Math.min(start + maxVisible, total),
  };
}

export function moveSelectedIndex(
  selectedIndex: number,
  total: number,
  delta: number,
): number {
  if (total === 0) return 0;
  return (selectedIndex + delta + total) % total;
}

export function pageSelectedIndex(
  selectedIndex: number,
  total: number,
  pageSize: number,
): number {
  if (total === 0) return 0;
  return clampSelectedIndex(selectedIndex + pageSize, total);
}

/**
 * Normalization key for read-time dedup (spec C3): byte-matches the
 * APPLIED patch key in nav/patches/editor.cjs (:480-:586) — whitespace
 * runs collapse, then trim, then a 120-char prefix slice, then lowercase.
 * The literal is the single-backslash applied-patch form; the raw patch
 * file stores \\s+ only because its code sits inside a template literal.
 * Shared by contract (spec C4): hide-prompts tombstone keys and the
 * merge-history session-half tombstone filter MUST byte-match this key.
 */
export function promptDedupKey(entry: string): string {
  return entry.replace(/\s+/g, " ").trim().slice(0, 120).toLowerCase();
}

/**
 * Read-time dedup pass (spec C3): keep-first over input order (file order
 * is newest-first, mirroring the patch's keep-first dedup-on-save), and
 * empty-key entries (empty or whitespace-only) are skipped — excluded from
 * the output and never usable as collision keys. Removes ONLY duplicate-
 * normalized entries; no snapshot cap (filterPrompts still caps output).
 * Generic over string | PromptEntry (WU3): over the COMBINED merged input
 * the keep-first rule makes the editor copy win at the seam — objects pass
 * through with provenance intact; no new dedup logic exists anywhere.
 */
export function dedupePromptEntries<T extends string | PromptEntry>(
  entries: readonly T[],
): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const entry of entries) {
    const key =
      typeof entry === "string"
        ? promptDedupKey(entry)
        : promptDedupKey(entry.text);
    if (key !== "" && !seen.has(key)) {
      seen.add(key);
      deduped.push(entry);
    }
  }
  return deduped;
}

/**
 * First-paint window size (spec C1, AC-L1-1): min(initialBatch, total),
 * floored at 0 — small stores open fully loaded (exhausted at open),
 * identical to today's behavior for R <= INITIAL_BATCH.
 */
export function initialLoadedCount(
  total: number,
  initialBatch: number,
): number {
  return Math.max(0, Math.min(initialBatch, total));
}

/**
 * Prefetch trigger (spec C2's normative expression, AC-L2-1): growth fires
 * iff rows remain unloaded AND the 0-based cursor sits within the final
 * preloadBuffer rows of the loaded window. Reads UNFILTERED counts only —
 * filteredRecords.length appears in no trigger arithmetic (AC-L2-2).
 */
export function shouldGrowWindow(
  selectedIndex: number,
  loadedCount: number,
  totalCount: number,
  preloadBuffer: number,
): boolean {
  return (
    loadedCount < totalCount && selectedIndex + preloadBuffer >= loadedCount
  );
}

/**
 * One growth step (spec C2, AC-L2-1): min(L + max(1, batchSize), R). The
 * max(1, ·) guard also keeps loadedCountForTarget's loop terminating on a
 * degenerate batch size.
 */
export function nextLoadedCount(
  loadedCount: number,
  totalCount: number,
  batchSize: number,
): number {
  const step = Math.max(1, batchSize);
  return Math.min(loadedCount + step, totalCount);
}

/**
 * PgDn catch-up (spec C1, AC-L1-5): the smallest whole-batch count that
 * strictly covers targetIndex (a 0-based master row), clamped at totalCount.
 * No-op when the target is already covered or the window is exhausted.
 * Terminates by construction: each step adds ≥ 1, bounded by totalCount.
 */
export function loadedCountForTarget(
  loadedCount: number,
  totalCount: number,
  targetIndex: number,
  batchSize: number,
): number {
  let next = loadedCount;
  while (next <= targetIndex && next < totalCount) {
    next = nextLoadedCount(next, totalCount, batchSize);
  }
  return next;
}

/**
 * Delete backfill (spec C4's two steps verbatim, AC-L4-1..3): decrement the
 * window against the splice-shrunk snapshot; while unloaded rows remain,
 * backfill one row (clamped) so the next unloaded record slides into the
 * deleted slot and the visible list length stays stable; at exhaustion the
 * decrement is the genuine shrink. Written stepwise — NOT the algebraic
 * min(L, T') shortcut — so the unit tests pin the contract, not an
 * equivalence. Callers guarantee the deleted row sits inside the loaded
 * prefix (idx < loadedCount by construction).
 */
export function loadedCountAfterDelete(
  loadedCount: number,
  totalCountAfterSplice: number,
): number {
  const decrement = loadedCount - 1;
  if (decrement < totalCountAfterSplice) {
    return Math.min(decrement + 1, totalCountAfterSplice);
  }
  return decrement;
}

/**
 * Pure delete-flow planner (spec C4, design §F): maps a record's provenance
 * to the two delete actions. "editor" deletes from the editor store on disk
 * AND writes the tombstone (twin suppression — the session copy of the same
 * text would otherwise resurface next open); "session" plans NOTHING —
 * session-derived rows are read-only (slice-05 D1): transcripts are
 * immutable and owned by Pi core, so the extension never deletes from or
 * writes to them, and deleteCurrent guards the source before the flow.
 * Takes source as a plain parameter (no member reads — the T23 provenance
 * pin keeps overlay consumers source-agnostic outside deleteCurrent); the
 * only consumer is the delete flow in history/index.ts.
 */
export function deletionActionsFor(
  source: PromptSource,
): { deleteFromEditorStore: boolean; writeTombstone: boolean } {
  if (source === "editor") {
    return { deleteFromEditorStore: true, writeTombstone: true };
  }
  return { deleteFromEditorStore: false, writeTombstone: false };
}

/**
 * One transition of the modal delete confirmation (PR #1393 follow-up,
 * slice-05 D3). Disarmed, only the delete combo matters: it ARMS the
 * confirm and executes nothing. While armed the confirm is MODAL: `y`/`Y`
 * executes, `n`/`N`/Esc cancels, and every other key — including a second
 * press of the combo — is swallowed with the confirm still armed (nothing
 * reaches the dispatch table or the search input). The TUI keybinding
 * matches (ctrl+shift+backspace, escape) are computed by the caller via
 * matchesKey and passed as plain booleans so this router stays pure and
 * testable without the TUI; the y/n semantics read the raw data here.
 * ONE definition: the selector's handleInput routes every armed-state key
 * through this function.
 */
export interface DeleteConfirmStep {
  /** The armed state AFTER this transition. */
  armed: boolean;
  /** True only when `y`/`Y` confirms the armed delete — run the flow. */
  execute: boolean;
  /** True when `n`/`N`/Esc cancels — disarm and resume normal input. */
  cancel: boolean;
}

export function deleteConfirmStep(
  armed: boolean,
  isDeleteKey: boolean,
  isEscapeKey: boolean,
  data: string,
): DeleteConfirmStep {
  if (!armed) {
    return isDeleteKey
      ? { armed: true, execute: false, cancel: false }
      : { armed: false, execute: false, cancel: false };
  }
  if (data === "y" || data === "Y") {
    return { armed: false, execute: true, cancel: false };
  }
  if (data === "n" || data === "N" || isEscapeKey) {
    return { armed: false, execute: false, cancel: true };
  }
  return { armed: true, execute: false, cancel: false };
}

/**
 * Confirmation copy shown in the footer while a delete is armed (PR
 * #1393): one line, one variant — a y/n question carrying the standing
 * guarantee that the session log keeps the original either way.
 */
export function deleteConfirmFooterText(): string {
  return "Delete this prompt from history (y/n)? Prompt stays in session log";
}

/**
 * Toast copy when the store delete THROWS (PR #1393): the flow aborts
 * before any tombstone write, so nothing was removed — the store keeps the
 * prompt and no tombstone is written.
 */
export const STORE_DELETE_FAILED_TEXT =
  "Store delete failed; nothing was removed.";

/**
 * Toast copy when the tombstone write fails on the EDITOR path (PR
 * #1393): the store row was already removed, so only the hide failed —
 * the prompt may reappear from session transcripts.
 */
export const EDITOR_HIDE_FAILED_TEXT =
  "Deleted from the store, but hiding failed — the prompt may reappear from session transcripts.";

/**
 * Toast copy when some store files could not be read or rewritten: copies
 * may remain on disk, and only the tombstone keeps them out of the list.
 */
export const STORE_DELETE_PARTIAL_TEXT =
  "Some history files could not be rewritten; the prompt is hidden, but copies may remain on disk.";

/** The counts a scope delete reports (structural twin of store's SweepResult). */
export interface StoreSweepCounts {
  filesAffected: number;
  removed: number;
  failed: number;
}

/**
 * What the delete flow does after the store sweep: proceed to the
 * tombstone when anything was removed OR any file failed (a failed file
 * may still hold a copy the tombstone must hide), surfacing an error
 * notice for failures; stop quietly when there was nothing to delete.
 */
export function storeDeleteFollowUp(
  counts: StoreSweepCounts,
): { proceed: boolean; notice?: string } {
  if (counts.failed > 0) {
    return { proceed: true, notice: STORE_DELETE_PARTIAL_TEXT };
  }
  return { proceed: counts.removed > 0 };
}

export function getVisiblePromptRecords(
  records: PromptRecord[],
  selectedIndex: number,
  maxVisible: number,
): VisiblePromptRecord[] {
  const { start, end } = computeVisibleRange(
    selectedIndex,
    records.length,
    maxVisible,
  );
  return records.slice(start, end).map((record, offset) => ({
    index: start + offset,
    record,
    isSelected: start + offset === selectedIndex,
  }));
}

export async function withExpandedHistoryGlobals<T>(
  globals: PiHistoryGlobals,
  run: () => Promise<T>,
): Promise<T> {
  globals.__piHistoryExpand?.();
  try {
    return await run();
  } finally {
    globals.__piHistoryTrim?.();
  }
}

/**
 * Full-snapshot visibility for non-empty queries (AC-L2-3r, user-directed
 * 2026-09-08): searching must see the whole deduped snapshot, not just the
 * loaded prefix. One-shot and idempotent — returns the total, never an
 * incremental batch — so per-keypress growth stays impossible. Empty or
 * whitespace-only queries leave the lazy window untouched.
 */
export function loadedCountForQuery(
  loadedCount: number,
  totalCount: number,
  query: string,
): number {
  return query.trim().length > 0 ? totalCount : loadedCount;
}

const MAX_RESULTS = 10000;

export function filterPrompts(
  records: PromptRecord[],
  query: string,
): PromptRecord[] {
  const trimmed = query.trim();
  if (!trimmed) return records.slice(0, MAX_RESULTS);

  const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = records.filter((record) => {
    return tokens.every((token) => record.searchText.includes(token));
  });

  return filtered.slice(0, MAX_RESULTS);
}
