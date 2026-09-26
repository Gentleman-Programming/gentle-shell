// SPDX-FileCopyrightText: 2026 ExoPro. Inspired by @jasonish/pi-prompt-history
// SPDX-License-Identifier: MIT

// Consolidated multi-concurrency store (v2), slices 1+2: project paths and
// identity, the advisory registry, entry primitives, the per-instance
// session writer, and the scope drain/reader/query section (ordering,
// dedup, tombstone filter, project/global drains). Legacy migration and
// seed bootstrap, scope deletes, and GC/compaction arrive in later slices.
// Formerly store-paths.ts + registry.ts + multi-store.ts (+ v1 primitives).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readHiddenPrompts } from "./hide-prompts.ts";

// ===========================================================================
// Paths (formerly store-paths.ts)
// ===========================================================================

/**
 * Project identity for the multi-concurrency store (design v2).
 *
 * The cwd is canonicalized through realpath — the same resolution pi's
 * session-manager applies — so symlinked or differently-spelled paths to one
 * project merge into a single identity. A failed resolution (deleted cwd)
 * falls back to hashing the raw string: identity degrades, never throws.
 */
export function projectHash(cwd: string): string {
  let canonical = cwd;
  try {
    canonical = fs.realpathSync(cwd);
  } catch {
    // fall back to the raw path
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** The project's directory under the store root. */
export function projectDir(root: string, cwd: string): string {
  return path.join(root, "projects", projectHash(cwd));
}

/** The capture file owned by one pi instance (per session/process). */
export function sessionFilePath(
  root: string,
  cwd: string,
  instanceId: string,
): string {
  return path.join(projectDir(root, cwd), `${instanceId}.jsonl`);
}

/** The rebuildable bootstrap output for a project. */
export function seedFilePath(root: string, cwd: string): string {
  return path.join(projectDir(root, cwd), "seed.jsonl");
}

/** The one-time legacy/global seed (never GC'd). */
export function globalSeedPath(root: string): string {
  return path.join(root, "history-global.jsonl");
}

/** Advisory hash → cwd map for display labels. */
export function registryPath(root: string): string {
  return path.join(root, "registry.json");
}

// ===========================================================================
// Registry (formerly registry.ts)
// ===========================================================================

export interface RegistryEntryResult {
  hash: string;
  created: boolean;
}

type RegistryData = Record<string, string>;

function readRegistry(root: string): RegistryData {
  try {
    const raw = fs.readFileSync(registryPath(root), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: RegistryData = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeRegistryAtomic(root: string, data: RegistryData): void {
  const target = registryPath(root);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, target);
}

/**
 * Ensure the advisory registry maps this project's hash to its cwd.
 * Idempotent: an existing identical entry writes nothing. A hash mapped to a
 * DIFFERENT cwd is a (practically unreachable) collision — the entry is
 * re-keyed at 24 hash chars so both identities coexist.
 */
export function ensureRegistryEntry(
  root: string,
  cwd: string,
): RegistryEntryResult {
  const hash = projectHash(cwd);
  const data = readRegistry(root);
  if (data[hash] === cwd) return { hash, created: false };
  // An earlier collision may have re-keyed THIS cwd to a long key.
  // Return the existing mapping unchanged so collision assignments stay
  // stable across calls instead of flipping the other occupant's key.
  const existingKey = Object.keys(data).find((k) => data[k] === cwd);
  if (existingKey !== undefined) return { hash: existingKey, created: false };
  if (data[hash] !== undefined) {
    // Collision: re-key the EXISTING occupant at 24 hash chars so both
    // identities coexist; the incoming cwd keeps the short hash — the
    // key shape projectDir/sessionFilePath/drains derive.
    const existing = data[hash];
    data[projectHashLong(existing)] = existing;
    data[hash] = cwd;
    writeRegistryAtomic(root, data);
    return { hash, created: true };
  }
  data[hash] = cwd;
  writeRegistryAtomic(root, data);
  return { hash, created: true };
}

function projectHashLong(cwd: string): string {
  // Reuse the same canonicalization as projectHash but keep 24 chars.
  let canonical = cwd;
  try {
    canonical = fs.realpathSync(cwd);
  } catch {
    // fall back to the raw path
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

// ===========================================================================
// Entry primitives (from v1 history-store.ts)
// ===========================================================================

/** One line of `editor-history.jsonl`. */
export interface StoreEntry {
  /** Schema version; 1 when absent in the source line. */
  v: number;
  text: string;
  /** Capture epoch-ms; optional, line order is authoritative for recency. */
  ts?: number;
}

/**
 * Parse one JSONL line. Returns null for malformed lines (bad JSON,
 * non-string or whitespace-only text) so callers can skip them; a torn
 * last line from a crash is handled the same way.
 */
export function parseStoreLine(raw: string): StoreEntry | null {
  if (raw.length === 0) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as { v?: unknown; text?: unknown; ts?: unknown };
    if (typeof record.text !== "string") return null;
    if (record.text.trim().length === 0) return null;
    const entry: StoreEntry = { v: 1, text: record.text };
    if (typeof record.v === "number" && Number.isFinite(record.v)) {
      entry.v = record.v;
    }
    if (typeof record.ts === "number" && Number.isFinite(record.ts)) {
      entry.ts = record.ts;
    }
    return entry;
  } catch {
    return null;
  }
}

// ===========================================================================
// Instance writer (formerly multi-store.ts; scope deletes and GC arrive
// in later slices)
// ===========================================================================

/** Mutable state of ONE pi instance's exclusive capture file. */
export interface SessionWriterState {
  filePath: string;
  /** Logical line count of this instance's file. */
  lineCount: number;
}

/** Command-like prompts (`/name ...`) are UI commands, not prompts. */
function isLikelyCommand(text: string): boolean {
  return /^\/[A-Za-z]/.test(text.trim());
}

function serializeEntry(entry: StoreEntry): string {
  const out: { v: number; text: string; ts?: number } = {
    v: entry.v,
    text: entry.text,
  };
  if (entry.ts !== undefined) out.ts = entry.ts;
  return JSON.stringify(out);
}

/**
 * Open the writer for this pi instance. The file is created LAZILY by the
 * first capture — starting pi must not litter empty files. Only this
 * instance ever appends here (design v2: zero shared writes).
 */
export function openSessionWriter(
  root: string,
  cwd: string,
  instanceId: string,
): SessionWriterState {
  return {
    filePath: sessionFilePath(root, cwd, instanceId),
    lineCount: 0,
  };
}

/**
 * Append one prompt line to the instance's own file (write-through).
 * Skips empty/whitespace-only and command-like prompts.
 */
export function appendSessionCapture(
  state: SessionWriterState,
  text: string,
  ts?: number,
): void {
  if (typeof text !== "string" || text.trim().length === 0) return;
  if (isLikelyCommand(text)) return;

  const entry: StoreEntry = { v: 1, text };
  if (ts !== undefined) entry.ts = ts;
  fs.mkdirSync(path.dirname(state.filePath), { recursive: true });
  fs.appendFileSync(state.filePath, serializeEntry(entry) + "\n", "utf8");
  state.lineCount += 1;
}


// ---------------------------------------------------------------------------
// Multi-file reader (design v2: k-way backward merge)
// ---------------------------------------------------------------------------

/** UI-level prompt identity: whitespace-collapsed, case-insensitive. */
function promptKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function fileMtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function listProjectFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(dir, e.name))
    .sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a));
}

/** Read one file's valid entries (chronological). */
function readFileEntries(file: string): StoreEntry[] {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries: StoreEntry[] = [];
  for (const lineText of raw.split("\n")) {
    const parsed = parseStoreLine(lineText);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

/**
 * Sort key = the newest entry ts in the file (fallback: file mtime).
 * ts-based keys are STABLE under atomic rewrites (deletes/compaction
 * bump mtime, which used to reshuffle the drain order).
 */
function fileSortKey(file: string, entries: StoreEntry[]): number {
  let maxTs = 0;
  for (const entry of entries) {
    if (entry.ts !== undefined && entry.ts > maxTs) maxTs = entry.ts;
  }
  return maxTs > 0 ? maxTs : fileMtimeMs(file);
}

/** Tombstone key - byte-compatible with hide-prompts' promptDedupKey. */
function promptDedupKeyOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 120).toLowerCase();
}

/**
 * Sequential backward drain over PRE-SORTED files: each file fully,
 * newest-line-first, deduped by UI-level identity, capped at `limit`.
 */
function drainFiles(
  files: string[],
  limit: number,
  hidden: Set<string> = new Set(),
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    const entries = readFileEntries(file);
    for (let i = entries.length - 1; i >= 0; i--) {
      const key = promptKey(entries[i].text);
      if (seen.has(key)) continue;
      if (hidden.size > 0 && hidden.has(promptDedupKeyOf(entries[i].text))) {
        continue;
      }
      seen.add(key);
      out.push(entries[i].text);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Sort files for draining: ts-keyed, newest first, empty files dropped. */
function sortFilesForDrain(files: string[]): string[] {
  return files
    .map((file) => ({ file, entries: readFileEntries(file) }))
    .filter((f) => f.entries.length > 0)
    .sort(
      (a, b) =>
        fileSortKey(b.file, b.entries) - fileSortKey(a.file, a.entries),
    )
    .map((f) => f.file);
}

/**
 * Result of a scope drain: `ok` with the drained prompts, or `blocked`
 * when the tombstone file is untrusted (fail-closed READ half). The
 * blocked shape carries NO prompts field, so a caller cannot accidentally
 * render prompts that may include hidden ones.
 */
export type DrainResult =
  | { status: "ok"; prompts: string[] }
  | { status: "blocked"; message: string };

/**
 * Shared drain tail: without a `stateDir` the raw drain semantics hold (no
 * filter). With one, the tombstone filter applies and fails CLOSED: an
 * untrusted hidden.json (unreadable, corrupt, wrong shape) blocks the
 * whole drain with the recovery message instead of resurfacing hidden
 * prompts; a missing file is the safe empty tombstone set and drains
 * normally.
 */
function drainWithHidden(
  files: string[],
  limit: number,
  stateDir?: string,
): DrainResult {
  if (!stateDir) return { status: "ok", prompts: drainFiles(files, limit) };
  const read = readHiddenPrompts(stateDir);
  if (read.status === "untrusted") {
    return { status: "blocked", message: read.message };
  }
  return { status: "ok", prompts: drainFiles(files, limit, read.keys) };
}

/**
 * Drain the PROJECT scope: all .jsonl files in the project dir (seed.jsonl
 * included), mtime-newest-first, deduped, capped at `limit` (default 1000).
 * With a `stateDir`, the tombstone filter applies and fails closed: an
 * untrusted hidden.json blocks the drain (see DrainResult).
 */
export function drainProject(
  root: string,
  cwd: string,
  limit: number = 1000,
  stateDir?: string,
): DrainResult {
  return drainWithHidden(
    sortFilesForDrain(listProjectFiles(path.join(root, "projects", projectHash(cwd)))),
    limit,
    stateDir,
  );
}

/**
 * Drain the GLOBAL scope: every project dir's files, mtime-newest-first,
 * deduped, capped — with the legacy global seed appended LAST (deliberate:
 * it is the least specific, migrated source, so per-project entries win
 * recency and keep-first dedup favors them). With a `stateDir`, the
 * tombstone filter applies and fails closed: an untrusted hidden.json
 * blocks the drain (see DrainResult).
 */
export function drainGlobal(
  root: string,
  limit: number = 1000,
  stateDir?: string,
): DrainResult {
  const files: string[] = [];
  const globalSeed = globalSeedPath(root);

  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(path.join(root, "projects"), {
      withFileTypes: true,
    });
  } catch {
    projectDirs = [];
  }
  for (const dirEntry of projectDirs) {
    if (!dirEntry.isDirectory()) continue;
    files.push(
      ...listProjectFiles(path.join(root, "projects", dirEntry.name)),
    );
  }
  const sorted = sortFilesForDrain(files);
  if (fs.existsSync(globalSeed)) sorted.push(globalSeed); // legacy last
  return drainWithHidden(sorted, limit, stateDir);
}
