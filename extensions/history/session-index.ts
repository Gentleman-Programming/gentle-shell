// SPDX-FileCopyrightText: 2026 ExoPro. Inspired by @jasonish/pi-prompt-history
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write.ts";
import { extractPromptsFromFile, listSessionFiles } from "./session-scan.ts";

/**
 * Schema version of prompt-index.json. An index carrying any other version
 * is discarded at load and fully rebuilt (fail-open, AC-S2-4).
 */
export const SESSION_INDEX_VERSION = 1;

/**
 * Index file name inside the injected state dir (design §D5). The module is
 * storage-dir agnostic: production wiring passes the pi-history-nav state
 * dir, tests pass injected temp dirs.
 */
const INDEX_FILE_NAME = "prompt-index.json";

/**
 * One user prompt in the index: the extracted text plus the resolved
 * ms-epoch ordering timestamp (fallback chain applied at scan time).
 */
export interface SessionPromptRecord {
  text: string;
  ts: number;
}

/**
 * Per-file freshness record. The file's ABSOLUTE PATH is the object KEY of
 * `SessionIndexState.files` (design §D5 ratification: single source of
 * identity, O(1) freshness lookup, deterministic `Object.keys().sort()`
 * flatten order). `(mtimeMs, size)` is the freshness pair — append-only
 * transcripts make it sound.
 */
export interface SessionFileRecord {
  mtimeMs: number;
  size: number;
  prompts: SessionPromptRecord[];
}

/**
 * The whole persisted index state. `version` must equal
 * SESSION_INDEX_VERSION or the state is discarded at load.
 */
export interface SessionIndexState {
  version: number;
  files: Record<string, SessionFileRecord>;
}

/**
 * Load the session index from `stateDir/prompt-index.json`. Fail-open
 * (AC-S2-4): a missing, unreadable, unparseable, wrong-version, or
 * wrong-shaped index is DISCARDED — null, identical to cold start — and the
 * call never throws. The selector never crashes on index state.
 */
export function loadSessionIndex(stateDir: string): SessionIndexState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(stateDir, INDEX_FILE_NAME), "utf8");
  } catch {
    return null; // missing or unreadable → cold start
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // unparseable garbage → discard
  }
  if (parsed == null || typeof parsed !== "object") return null;
  const state = parsed as SessionIndexState;
  if (state.version !== SESSION_INDEX_VERSION) return null;
  if (
    state.files == null ||
    typeof state.files !== "object" ||
    Array.isArray(state.files)
  ) {
    return null; // wrong shape → discard
  }
  return state;
}

/**
 * Persist the session index into `stateDir/prompt-index.json` through the
 * shared atomic tmp+rename writer. Returns true on success; a write failure
 * returns false and never throws (cache semantics — silent, design §D3).
 */
export function persistSessionIndex(
  stateDir: string,
  index: SessionIndexState,
): boolean {
  return writeJsonAtomic(path.join(stateDir, INDEX_FILE_NAME), index);
}

// ---------------------------------------------------------------------------
// WU2b — freshness: stat-pass refresh, stable collect, chunked background build
// ---------------------------------------------------------------------------

/** Default synchronous rescan budget per open (design §D7). */
export const DEFAULT_SYNC_CHANGED_FILE_LIMIT = 64;

/** Options for one incremental refresh pass over the sessions root. */
export interface RefreshSessionIndexOptions {
  sessionsRoot: string;
  index: SessionIndexState;
  stateDir: string;
  /**
   * Max changed+new+dropped files rescanned synchronously per open. Above it
   * the STALE index is served and the rescan is handed to the chunked
   * background build — bounded open latency (design §D7, §Risk 8).
   */
  syncChangedFileLimit?: number;
}

/** Result of one incremental refresh pass (the C2 open path). */
export interface RefreshResult {
  /** The index to serve THIS open: refreshed, or the stale input when deferred. */
  index: SessionIndexState;
  /** Files actually rescanned synchronously (empty when nothing changed or deferred). */
  changedPaths: string[];
  /** True when exactly one atomic persist wrote the refreshed index. */
  persisted: boolean;
  /** True when changes exceeded the sync limit and were deferred to the background build. */
  deferred: boolean;
}

/**
 * One incremental refresh pass (AC-S2-1..3): one-level candidate discovery,
 * then an O(files) statSync pass — never O(bytes). Unchanged (mtimeMs, size)
 * pairs serve their cached records; changed or new files are rescanned once
 * via extractPromptsFromFile; records whose file is gone from disk drop. Any
 * applied change persists exactly once, atomically. A mass change above
 * `syncChangedFileLimit` defers: the stale index is returned untouched
 * (deferred: true) and the rescan is handed to the chunked background build.
 * Never throws: a file that vanishes between listing and stat is treated as
 * deleted, and persistence failures stay silent cache semantics (design §D3).
 */
export function refreshSessionIndex({
  sessionsRoot,
  index,
  stateDir,
  syncChangedFileLimit = DEFAULT_SYNC_CHANGED_FILE_LIMIT,
}: RefreshSessionIndexOptions): RefreshResult {
  const files = listSessionFiles(sessionsRoot);
  const listed = new Set(files);
  const nextFiles: Record<string, SessionFileRecord> = {};
  const carried = new Set<string>();
  const changedPaths: string[] = [];
  let dropped = 0;

  // Deletions first: records whose file no longer exists on disk drop.
  for (const filePath of Object.keys(index.files)) {
    if (!listed.has(filePath)) {
      dropped++;
      continue;
    }
    nextFiles[filePath] = index.files[filePath];
    carried.add(filePath);
  }

  // Stat pass over the candidates: rescan ONLY changed or new files.
  for (const filePath of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // Vanished between listing and stat → treat as deleted.
      if (carried.delete(filePath)) dropped++;
      continue;
    }
    const cached: SessionFileRecord | undefined = index.files[filePath];
    if (
      cached !== undefined &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      continue; // unchanged → the cached record was already carried over
    }
    const scan = extractPromptsFromFile(filePath);
    nextFiles[filePath] = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      prompts: scan.prompts,
    };
    changedPaths.push(filePath);
  }

  const changeCount = changedPaths.length + dropped;
  if (changeCount > syncChangedFileLimit) {
    // Mass-touch: serve the STALE index this open; the background build owns
    // the rescan — bounded open latency, freshness from the next open (§D7).
    return { index, changedPaths: [], persisted: false, deferred: true };
  }
  if (changeCount > 0) {
    const nextIndex: SessionIndexState = {
      version: SESSION_INDEX_VERSION,
      files: nextFiles,
    };
    const persisted = persistSessionIndex(stateDir, nextIndex);
    return { index: nextIndex, changedPaths, persisted, deferred: false };
  }
  return { index, changedPaths: [], persisted: false, deferred: false };
}

/**
 * Flatten the index into ordering-ready prompt entries: Object.keys() sorted
 * (deterministic scan order), then a STABLE sort ts descending — equal ts
 * keep the sorted-path order, and a non-finite ts (ordering-only residue)
 * sinks to the end deterministically. Never throws on a wrong-shaped record:
 * values from a fail-open load are treated as unknown at this boundary.
 */
export function collectSessionEntries(
  index: SessionIndexState,
): SessionPromptRecord[] {
  const entries: SessionPromptRecord[] = [];
  const rawFiles: unknown = index.files;
  for (const filePath of Object.keys(index.files).sort()) {
    const record = (rawFiles as Record<string, unknown>)[filePath];
    if (record == null || typeof record !== "object") continue;
    const rawPrompts = (record as { prompts?: unknown }).prompts;
    if (!Array.isArray(rawPrompts)) continue;
    for (const prompt of rawPrompts) {
      if (prompt == null || typeof prompt !== "object") continue;
      const fields = prompt as { text?: unknown; ts?: unknown };
      entries.push({
        text: typeof fields.text === "string" ? fields.text : "",
        ts: typeof fields.ts === "number" ? fields.ts : NaN,
      });
    }
  }
  return entries.sort((a, b) => {
    const ta = Number.isFinite(a.ts) ? a.ts : -Infinity;
    const tb = Number.isFinite(b.ts) ? b.ts : -Infinity;
    return tb - ta;
  });
}

/** Files processed per background-build tick (design §D7; measurement-locked). */
export const INDEX_BUILD_CHUNK = 32;

/** Options for the chunked background index build. */
export interface BackgroundIndexBuildOptions {
  stateDir: string;
  sessionsRoot: string;
  onProgress?: (processed: number, total: number) => void;
}

/** Module-level in-flight guard: concurrent builds dedupe onto one promise. */
let inFlightBuild: Promise<SessionIndexState | null> | null = null;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function runBackgroundBuild(
  options: BackgroundIndexBuildOptions,
): Promise<SessionIndexState | null> {
  try {
    const files = listSessionFiles(options.sessionsRoot);
    const total = files.length;
    const index: SessionIndexState = {
      version: SESSION_INDEX_VERSION,
      files: {},
    };
    let skippedLines = 0;
    let processed = 0;
    for (let start = 0; start < files.length; start += INDEX_BUILD_CHUNK) {
      const chunk = files.slice(start, start + INDEX_BUILD_CHUNK);
      for (const filePath of chunk) {
        // A file that vanishes mid-build throws here — the whole-build catch
        // below fails open to null (self-healing on the next open).
        const stat = fs.statSync(filePath);
        const scan = extractPromptsFromFile(filePath);
        skippedLines += scan.skippedLines;
        index.files[filePath] = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          prompts: scan.prompts,
        };
        processed++;
      }
      options.onProgress?.(processed, total);
      if (start + INDEX_BUILD_CHUNK < files.length) {
        await yieldToEventLoop(); // yield between ticks, never after the last
      }
    }
    persistSessionIndex(options.stateDir, index); // one atomic persist at completion
    options.onProgress?.(total, total); // guaranteed terminal total-total call
    return index;
  } catch {
    return null; // fail-open: a failed build self-heals on the next open
  }
}

/**
 * Kick the chunked background index build (design §D7): INDEX_BUILD_CHUNK
 * files per tick with a setTimeout(0) yield between ticks, one atomic persist
 * at completion. A second call while a
 * build is in flight attaches to the SAME promise (no duplicate scan). The
 * open path never awaits this — tests MAY await it over fixture corpora, and
 * every tick timer fires before the promise settles, so no timer leaks.
 */
export function startBackgroundIndexBuild(
  options: BackgroundIndexBuildOptions,
): Promise<SessionIndexState | null> {
  if (inFlightBuild !== null) return inFlightBuild;
  const build = runBackgroundBuild(options);
  inFlightBuild = build.finally(() => {
    inFlightBuild = null;
  });
  return inFlightBuild;
}
