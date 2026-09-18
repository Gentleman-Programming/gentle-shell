// SPDX-FileCopyrightText: 2026 ExoPro. Inspired by @jasonish/pi-prompt-history
// SPDX-License-Identifier: MIT

// Consolidated multi-concurrency store (v2), slices 1+2+4: project paths
// and identity, the advisory registry, entry primitives, the per-instance
// session writer, the scope drain/reader/query section (ordering, dedup,
// tombstone filter, project/global drains), legacy migration, and the
// project seed bootstrap. Scope deletes and GC/compaction arrive in later
// slices. Formerly store-paths.ts + registry.ts + multi-store.ts (+ v1
// primitives).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadHiddenPrompts } from "./hide-prompts.ts";
import { loadSharedHistory } from "./load-shared-history.ts";
import {
  extractPromptsFromFile,
  listSessionFiles,
  type ExtractedPrompt,
} from "./session-scan.ts";

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
// Instance writer (formerly multi-store.ts; GC/compaction arrives in a
// later slice)
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
 * Drain the PROJECT scope: all .jsonl files in the project dir (seed.jsonl
 * included), mtime-newest-first, deduped, capped at `limit` (default 1000).
 */
export function drainProject(
  root: string,
  cwd: string,
  limit: number = 1000,
  stateDir?: string,
): string[] {
  return drainFiles(
    sortFilesForDrain(listProjectFiles(path.join(root, "projects", projectHash(cwd)))),
    limit,
    stateDir ? loadHiddenPrompts(stateDir) : new Set<string>(),
  );
}

/**
 * Drain the GLOBAL scope: every project dir's files, mtime-newest-first,
 * deduped, capped — with the legacy global seed appended LAST (deliberate:
 * it is the least specific, migrated source, so per-project entries win
 * recency and keep-first dedup favors them).
 */
export function drainGlobal(
  root: string,
  limit: number = 1000,
  stateDir?: string,
): string[] {
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
  return drainFiles(
    sorted,
    limit,
    stateDir ? loadHiddenPrompts(stateDir) : new Set<string>(),
  );
}

// ---------------------------------------------------------------------------
// Scope delete (design v2)
// ---------------------------------------------------------------------------

interface SweepResult {
  filesAffected: number;
  removed: number;
}

/**
 * Remove every line whose prompt identity matches `text` from each file in
 * `files`, one atomic rewrite (tmp + rename) per affected file. Files whose
 * every line matched are kept as empty files (never removed — the instance
 * owning a session file may still append to it).
 */
function sweepFiles(files: string[], text: string): SweepResult {
  const key = promptKey(text);
  let filesAffected = 0;
  let removed = 0;
  for (const file of files) {
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const kept: string[] = [];
    let fileRemoved = 0;
    for (const lineText of raw.split("\n")) {
      const parsed = parseStoreLine(lineText);
      if (!parsed) continue;
      if (promptKey(parsed.text) === key) {
        fileRemoved += 1;
      } else {
        kept.push(JSON.stringify(parsed));
      }
    }
    if (fileRemoved === 0) continue;
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, kept.length > 0 ? kept.join("\n") + "\n" : "", "utf8");
    fs.renameSync(tmp, file);
    filesAffected += 1;
    removed += fileRemoved;
  }
  return { filesAffected, removed };
}

/** Delete every copy of a prompt from the CURRENT project's scope. */
export function deleteFromProject(
  root: string,
  cwd: string,
  text: string,
): SweepResult {
  return sweepFiles(
    listProjectFiles(path.join(root, "projects", projectHash(cwd))),
    text,
  );
}

/** Delete every copy of a prompt from the GLOBAL scope (all projects + seed). */
export function deleteFromGlobal(root: string, text: string): SweepResult {
  const files: string[] = [];
  const globalSeed = globalSeedPath(root);
  if (fs.existsSync(globalSeed)) files.push(globalSeed);
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
  return sweepFiles(files, text);
}

// ---------------------------------------------------------------------------
// Legacy migration (design v2: one-time, gated)
// ---------------------------------------------------------------------------

export interface MigrationResult {
  migrated: number;
  ran: boolean;
}

function readValidLines(file: string): StoreEntry[] {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const entries: StoreEntry[] = [];
    for (const lineText of raw.split("\n")) {
      const parsed = parseStoreLine(lineText);
      if (parsed) entries.push(parsed);
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * One-time migration from the v1 stores into the v2 global seed:
 * - `~/.pi/agent/editor-history.jsonl` (v1 single-file store)
 * - `~/.pi/agent/editor-history.json` (pre-v1 array, newest-first)
 * Content lands in `pi-history/history-global.jsonl` chronologically; only
 * after the seed write succeeds is each source renamed `.imported`, never
 * deleted — a failed write leaves sources untouched for a later retry.
 * Gated: an existing global seed means migration already ran.
 */
export function migrateLegacyStores(
  root: string,
  agentDir: string,
): MigrationResult {
  const seed = globalSeedPath(root);
  if (fs.existsSync(seed)) return { migrated: 0, ran: false };

  const collected: StoreEntry[] = [];

  // Pre-v1 array (newest-first) → reverse to chronological.
  const legacyArray = path.join(agentDir, "editor-history.json");
  if (fs.existsSync(legacyArray)) {
    const texts = loadSharedHistory(legacyArray);
    for (let i = texts.length - 1; i >= 0; i--) {
      collected.push({ v: 1, text: texts[i] });
    }
  }

  // v1 single-file store — already chronological.
  const v1File = path.join(agentDir, "editor-history.jsonl");
  if (fs.existsSync(v1File)) {
    collected.push(...readValidLines(v1File));
  }

  if (collected.length === 0) return { migrated: 0, ran: false };

  fs.mkdirSync(path.dirname(seed), { recursive: true });
  const tmp = `${seed}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(
    tmp,
    collected.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
  fs.renameSync(tmp, seed);

  // The seed write is the source of truth: rename sources only once it
  // succeeded, so a failure can never strand entries in .imported files.
  for (const src of [legacyArray, v1File]) {
    try {
      if (fs.existsSync(src)) fs.renameSync(src, `${src}.imported`);
    } catch {
      // benign: the seed gate prevents duplicate import on the next run
    }
  }
  return { migrated: collected.length, ran: true };
}

// ---------------------------------------------------------------------------
// Project bootstrap (design v2: seed.jsonl)
// ---------------------------------------------------------------------------

export interface SeedResult {
  seeded: number;
  ran: boolean;
}

/**
 * Seed `projects/<hash>/seed.jsonl` from the project's pi transcripts when
 * the project dir holds fewer than `target` entries. Existing session files
 * are counted; their prompts are NOT re-seeded (dedupe by UI-level key).
 * The seed is a rebuildable cache — rewritten only when the dir is empty.
 */
export function bootstrapProjectSeed(
  root: string,
  cwd: string,
  sessionsRoot: string,
  target: number,
  stateDir?: string,
): SeedResult {
  const dir = path.join(root, "projects", projectHash(cwd));

  // Count existing entries and collect their identities.
  const existingKeys = new Set<string>();
  let existingCount = 0;
  for (const file of listProjectFiles(dir)) {
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const lineText of raw.split("\n")) {
      const parsed = parseStoreLine(lineText);
      if (parsed) {
        existingCount += 1;
        existingKeys.add(promptKey(parsed.text));
      }
    }
  }
  if (existingCount >= target) return { seeded: 0, ran: false };
  // The seed is written ONCE: an existing seed is never regenerated, so a
  // deleted prompt cannot be resurrected from transcripts on a new session.
  if (fs.existsSync(seedFilePath(root, cwd))) {
    return { seeded: 0, ran: false };
  }
  // Tombstones (user deletions) suppress transcript prompts from seeding.
  const hidden = stateDir ? loadHiddenPrompts(stateDir) : new Set<string>();

  // Scan transcripts: session files of THIS project's dir, newest first.
  let files: string[] = [];
  try {
    const dirName = cwd
      .replace(/^[/\\]/, "")
      .replace(/[/\\:]/g, "-");
    files = listSessionFiles(sessionsRoot).filter((file) =>
      file.includes(`${path.sep}--${dirName}--${path.sep}`),
    );
  } catch {
    return { seeded: 0, ran: false };
  }
  files.sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a));

  const collected: StoreEntry[] = [];
  outer: for (const file of files) {
    let prompts: ExtractedPrompt[] = [];
    try {
      prompts = extractPromptsFromFile(file).prompts;
    } catch {
      continue;
    }
    for (let i = prompts.length - 1; i >= 0; i--) {
      const text = prompts[i].text;
      if (/^\/[A-Za-z]/.test(text.trim())) continue;
      if (hidden.size > 0 && hidden.has(promptDedupKeyOf(text))) continue;
      const key = promptKey(text);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      const entry: StoreEntry = { v: 1, text };
      if (Number.isFinite(prompts[i].ts)) entry.ts = prompts[i].ts;
      collected.push(entry);
      if (collected.length >= target - existingCount) break outer;
    }
  }
  if (collected.length === 0) return { seeded: 0, ran: false };

  collected.reverse(); // chronological (oldest first)
  const seed = seedFilePath(root, cwd);
  fs.mkdirSync(path.dirname(seed), { recursive: true });
  const tmp = `${seed}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(
    tmp,
    collected.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
  fs.renameSync(tmp, seed);
  return { seeded: collected.length, ran: true };
}
