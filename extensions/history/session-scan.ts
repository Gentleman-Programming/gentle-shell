// SPDX-FileCopyrightText: 2026 ExoPro. Inspired by @jasonish/pi-prompt-history
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";

/**
 * One user prompt extracted from a pi session transcript file.
 *
 * `ts` is the resolved ordering timestamp in milliseconds since the epoch.
 * It follows the documented fallback chain (message ms-epoch → entry ISO →
 * header ISO → file mtime) and exists for ordering only — extraction never
 * fails because of it.
 */
export interface ExtractedPrompt {
  text: string;
  ts: number;
}

/**
 * Result of scanning one session file: the extracted user prompts (in file
 * order) plus `skippedLines`, the number of gate-passing lines whose JSON
 * could not be parsed. Parse failures are counted, never fatal.
 */
export interface FileScanResult {
  prompts: ExtractedPrompt[];
  skippedLines: number;
}

/**
 * Maximum extracted prompt length in UTF-16 code units (`text.length`). A
 * prompt strictly greater than this is skipped; at the maximum it still
 * extracts. The skip is uniform and silent (design §D1).
 */
export const MAX_PROMPT_CHARS = 16384;

/**
 * Cheap per-line substring prefilter literal. PREFILTER ONLY: a miss means
 * the line is never parsed; the parsed extraction rule below is the only
 * membership authority.
 */
const USER_ROLE_LITERAL = '"role":"user"';

/** Defensive field-access shapes for session JSONL values. */
interface SessionFields {
  type?: unknown;
  version?: unknown;
  timestamp?: unknown;
  message?: unknown;
}

interface MessageFields {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
}

/**
 * Validate the line-1 session header. A file is admitted only when the
 * header parses, carries type "session", and a numeric version ≤ 3
 * (format v3; legacy v1/v2 tolerated). Mirrors pi's loadEntriesFromFile
 * tolerance: any miss yields an empty scan, never a throw. Returns the
 * header timestamp in ms, or NaN when absent or unparseable.
 */
function parseHeader(line: string): number | null {
  let header: unknown;
  try {
    header = JSON.parse(line);
  } catch {
    return null;
  }
  if (header == null || typeof header !== "object") return null;
  const fields = header as SessionFields;
  if (fields.type !== "session") return null;
  if (typeof fields.version !== "number" || !(fields.version <= 3)) {
    return null;
  }
  return typeof fields.timestamp === "string"
    ? Date.parse(fields.timestamp)
    : NaN;
}

/**
 * Extract the prompt text from a user message's content: plain string
 * content passes through as-is; block arrays join their text blocks with a
 * single space and trim the assembly (upstream extractTextContent rule,
 * design §D1) — images and other block types are ignored, and zero text
 * blocks yield no prompt. Returns null when no prompt text exists.
 */
function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      block != null &&
      typeof block === "object" &&
      (block as SessionFields).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  if (parts.length === 0) return null;
  return parts.join(" ").trim();
}

/**
 * Resolve a prompt's ordering timestamp: message ms-epoch, then entry ISO,
 * then header ISO, then the file mtime. Every hop is NaN-tolerant; ordering
 * data is never worth a throw.
 */
function resolveTimestamp(
  entry: SessionFields,
  message: MessageFields,
  headerTs: number,
  filePath: string,
): number {
  if (
    typeof message.timestamp === "number" &&
    Number.isFinite(message.timestamp)
  ) {
    return message.timestamp;
  }
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (!Number.isNaN(headerTs)) return headerTs;
  try {
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    if (!Number.isNaN(mtimeMs)) return mtimeMs;
  } catch {
    // The file vanished between read and stat — leave the NaN residue.
  }
  return NaN;
}

/**
 * Extract every user prompt from one pi session transcript file.
 *
 * Pipeline (design §C): line-1 header admission gate; per line the cheap
 * USER_ROLE_LITERAL substring gate as a PREFILTER ONLY (gate misses are
 * never parsed); JSON.parse with a counted skip on throw; then the parsed
 * extraction rule (entry type "message" AND user role) as the only
 * membership authority. Whitespace-only text is skipped silently, and text
 * above MAX_PROMPT_CHARS skips uniformly. UI-free and fs-only: data-path
 * errors degrade to empty or partial results and never throw.
 */
export function extractPromptsFromFile(filePath: string): FileScanResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { prompts: [], skippedLines: 0 };
  }

  const lines = raw.split("\n");
  const headerTs = parseHeader(lines[0]);
  if (headerTs === null) return { prompts: [], skippedLines: 0 };

  const prompts: ExtractedPrompt[] = [];
  let skippedLines = 0;

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    // Prefilter: a miss never reaches JSON.parse.
    if (!line.includes(USER_ROLE_LITERAL)) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      skippedLines++;
      continue;
    }
    if (entry == null || typeof entry !== "object") continue;

    const record = entry as SessionFields;
    if (record.type !== "message") continue;
    if (record.message == null || typeof record.message !== "object") continue;
    const message = record.message as MessageFields;
    if (message.role !== "user") continue;

    const text = extractText(message.content);
    if (text === null || text.trim() === "") continue; // silent, not counted
    if (text.length > MAX_PROMPT_CHARS) continue; // uniform silent length skip

    prompts.push({
      text,
      ts: resolveTimestamp(record, message, headerTs, filePath),
    });
  }

  return { prompts, skippedLines };
}

/**
 * One-level scan rule (C1): list the top-level `*.jsonl` session files of
 * every encoded-cwd directory under the pi sessions root. Only DIRECTORIES
 * at the root are entered (stray root-level files are skipped) and only
 * their top-level jsonl files are candidates — nested subagent payloads
 * (`run-N/session.jsonl`) and `subagent-artifacts/` subtrees are directories
 * and are never descended. An unreadable root yields an empty list and a
 * directory whose readdir fails is skipped — never fatal. Returns sorted
 * absolute paths for deterministic scan order. Mirrors pi's non-recursive
 * listSessionsFromDir (session-manager.ts:822-826, read-only).
 */
export function listSessionFiles(sessionsRoot: string): string[] {
  let rootEntries: fs.Dirent[];
  try {
    rootEntries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const rootEntry of rootEntries) {
    if (!rootEntry.isDirectory()) continue;
    const dirPath = path.join(sessionsRoot, rootEntry.name);
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue; // one unreadable directory skips itself, never fatal
    }
    for (const child of children) {
      if (child.isFile() && child.name.endsWith(".jsonl")) {
        files.push(path.join(dirPath, child.name));
      }
    }
  }
  return files.sort();
}
