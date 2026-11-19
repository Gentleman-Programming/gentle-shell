// Where a Gentle Shell terminal's conversation lives, and how to read only what was added.
//
// MAPPING (T4): every live Gentle Shell session publishes a snapshot
// (`gentle-shell.desktop-feed/v1`, extensions/gentle-desktop-feed.ts) under
// `<agentDir>/desktop/sessions/<sessionId>.json` that names its exact session file, its agent
// dir, its pid/ppid/ancestors and its Herdr pane id. Snapshots are read from every agent dir
// (./snapshot.js agentRoots: ~/.gentle-shell/agent, ~/.pi/agent, the roots file).
// `sessionFileFor` matches a terminal against those snapshots first; only when none matches (an
// older Gentle Shell, a session before its first write) does it fall back to the T1 folder
// heuristic in every agent dir, where several sessions in one folder are ambiguous (the newest
// file wins).

import { readFile, readdir } from "fs/promises";
import { exec } from "herdr";
import { agentRoots, matchFeed, readFeeds } from "./snapshot.js";

export { FEED_SCHEMA, matchFeed, readFeeds } from "./snapshot.js";

// Mirror of pi's getDefaultSessionDirPath (lib/gentle-shell-resume-hint.ts piDefaultSessionDir):
// pi names a session folder after the real path of its cwd, under its agent dir.
export const sessionDirOf = (realCwd, agentDir) =>
  `${agentDir}/sessions/--${realCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

// The real path of a folder (macOS: /tmp is /private/tmp). Falls back to the folder as given.
async function realpath(dir) {
  try {
    const r = await exec("pwd", ["-P"], { cwd: dir, timeout: 5000 });
    const out = r.code === 0 ? r.stdout.trim() : "";
    return out || dir;
  } catch {
    return dir;
  }
}

// THE mapping: { dir, file, feed } for a terminal (an entry of `terminals()`), or null when it
// has neither a snapshot nor a folder. With a snapshot, `file` is its exact session file and
// `feed` the snapshot. Otherwise `file` is the newest `*.jsonl` of the folder's session dir in
// every agent dir (the matched snapshot's own agent dir first), null before the first message
// (names start with an ISO timestamp, so the name order is the time order); `dir` is the folder
// that file is in, else the first agent dir's. `real`: the caller's cwd -> real path memo, so the
// folder is resolved once per terminal folder, not every tick. `feeds`: the live snapshots the
// caller already has (S13: the shared reader's), else they are read here.
export async function sessionFileFor(terminal, real = new Map(), feeds = null) {
  const roots = await agentRoots();
  const feed = matchFeed(terminal, feeds ?? await readFeeds(roots));
  const exact = feed?.identity?.sessionFile;
  if (typeof exact === "string" && exact.endsWith(".jsonl")) {
    return { dir: exact.slice(0, Math.max(exact.lastIndexOf("/"), exact.lastIndexOf("\\"))), file: exact, feed };
  }
  const cwd = terminal?.cwd;
  if (!cwd) return null;
  if (!real.has(cwd)) real.set(cwd, await realpath(cwd));
  const own = feed?.identity?.agentDir;
  const dirs = [...new Set([...(typeof own === "string" ? [own] : []), ...roots])].map((root) => sessionDirOf(real.get(cwd), root));
  let best = null;
  for (const dir of dirs) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    const newest = names.filter((n) => n.endsWith(".jsonl")).sort().pop();
    if (newest && (!best || newest > best.name)) best = { dir, name: newest };
  }
  if (!best) return { dir: dirs[0], file: null, feed };
  return { dir: best.dir, file: `${best.dir}/${best.name}`, feed };
}

// UTF-8 bytes to a string (no TextDecoder here, and Buffer can't decode). Invalid bytes
// become U+FFFD.
export function utf8(bytes) {
  let out = "";
  let units = [];
  const flush = () => { out += String.fromCharCode.apply(null, units); units = []; };
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let cp = 0xfffd, n = 1;
    if (b < 0x80) cp = b;
    else if (b >= 0xc2 && b < 0xe0 && i + 1 < bytes.length) { cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f); n = 2; }
    else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) { cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); n = 3; }
    else if (b >= 0xf0 && b < 0xf5 && i + 3 < bytes.length) { cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); n = 4; }
    i += n;
    if (cp > 0xffff) { cp -= 0x10000; units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); }
    else units.push(cp);
    if (units.length >= 0x4000) flush();
  }
  flush();
  return out;
}

// The complete lines after byte `pos`, the byte they end at and the file's size. `text` is null
// when the file shrank or vanished (start over). A half-written last line waits for the next read.
// Only the new bytes are decoded and parsed. The runtime has no ranged read and no stat, so the
// bytes are fetched whole and sliced; `viaExec` (a big file, S13) asks `sh` for the size and the
// new bytes only instead: one process, no multi-megabyte copy per write.
// `max` caps one slice so a huge first read doesn't stall the UI thread (`more` = call again).
export async function readAfter(file, pos, max = 2 * 1024 * 1024, viaExec = false) {
  if (viaExec) return readOutside(file, pos, max);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (e) {
    // Herdr grants mods read access to the home folder only; a session resumed from elsewhere
    // (`gentle-shell --session /tmp/x.jsonl`) is read through `exec` instead.
    if (OUTSIDE.test(String(e?.message ?? e))) return readOutside(file, pos, max);
    return { text: null, end: 0, more: false, size: 0 };
  }
  const size = bytes.length;
  if (size < pos) return { text: null, end: 0, more: false, size };
  const last = bytes.lastIndexOf(10) + 1;
  let end = pos + max < last ? bytes.lastIndexOf(10, pos + max - 1) + 1 : last;
  if (end <= pos) end = last; // one line longer than max
  if (end <= pos) return { text: "", end: pos, more: false, size };
  return { text: utf8(bytes.subarray(pos, end)), end, more: end < last, size };
}

// The last whole lines of a file (S13: a long session's first paint decodes and draws its end,
// not megabytes of history): at least `tail` bytes and at least `lines` lines, but no more than
// `max` bytes (a few huge tool results must not leave only three messages, nor a long run of
// short lines a whole file). { text, start, end, size }, `start` the byte the first whole line
// begins at (0: the whole file). Null when it cannot be read. Outside the read roots: `tail`
// bytes, through `sh`.
export async function readTail(file, tail, lines = 0, max = Infinity) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (e) {
    if (OUTSIDE.test(String(e?.message ?? e))) return readTailOutside(file, tail);
    return null;
  }
  const size = bytes.length;
  let start = Math.max(0, size - tail);
  if (lines > 0 && start > 0) {
    const floor = Math.max(0, size - max);
    let i = size - 2; // past a final newline
    let at = size;
    for (let n = 0; n < lines; n++) {
      const nl = i >= 0 ? bytes.lastIndexOf(10, i) : -1;
      if (nl < floor) { at = floor; break; }
      at = nl + 1;
      i = nl - 1;
    }
    start = Math.min(start, at);
  }
  if (start > 0) {
    const nl = bytes.indexOf(10, start - 1);
    start = nl < 0 ? size : nl + 1;
  }
  const end = Math.max(start, bytes.lastIndexOf(10) + 1);
  return { text: end > start ? utf8(bytes.subarray(start, end)) : "", start, end, size };
}

const OUTSIDE = /outside every granted read root/i;
const EXEC_MAX = 6 * 1024 * 1024; // exec output is capped at 8 MiB

// Bytes UTF-8 needs for a string (the exec path gets text, the position is in bytes).
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// readAfter for a file outside the read roots: its size, then the bytes after `pos`, from one
// `sh` (the path and numbers are positional arguments, never part of the script).
async function readOutside(file, pos, max) {
  const cap = Math.max(1, Math.min(max * 3, EXEC_MAX));
  let r;
  try {
    r = await exec("sh", ["-c", 'wc -c < "$2" && tail -c +"$1" "$2" | head -c "$3"', "sh", String(pos + 1), file, String(cap)], { timeout: 15000 });
  } catch {
    return { text: null, end: 0, more: false };
  }
  const cut = r.stdout.indexOf("\n");
  const size = Number.parseInt(r.stdout.slice(0, cut), 10);
  if (r.code !== 0 || cut < 0 || !Number.isFinite(size) || size < pos) return { text: null, end: 0, more: false, size: Number.isFinite(size) ? size : 0 };
  if (size === pos) return { text: "", end: pos, more: false, size }; // it did not grow
  const chunk = r.stdout.slice(cut + 1);
  const last = chunk.lastIndexOf("\n") + 1;
  if (last === 0) return { text: "", end: pos, more: false, size };
  const text = chunk.slice(0, last);
  const end = pos + utf8Length(text);
  return { text, end, more: utf8Length(chunk) >= cap && end < size, size };
}

// readTail through `sh`: the size, then the byte the first whole line of the last `tail` bytes
// starts at (counted in bytes by `awk` in the C locale), then the bytes from there.
async function readTailOutside(file, tail) {
  const script = 's=$(wc -c < "$2") || exit 1; p=0; if [ "$s" -gt "$1" ]; then p=$((s - $1)); '
    + 'n=$(tail -c +"$p" "$2" | LC_ALL=C awk \'{ print length($0); exit }\'); p=$((p + n)); fi; '
    + '[ "$p" -gt "$s" ] && p=$s; echo "$s"; echo "$p"; tail -c +"$((p + 1))" "$2" | head -c "$3"';
  let r;
  try {
    r = await exec("sh", ["-c", script, "sh", String(tail), file, String(EXEC_MAX)], { timeout: 15000 });
  } catch {
    return null;
  }
  const a = r.stdout.indexOf("\n");
  const b = r.stdout.indexOf("\n", a + 1);
  const size = Number.parseInt(r.stdout.slice(0, a), 10);
  const start = Number.parseInt(r.stdout.slice(a + 1, b), 10);
  if (r.code !== 0 || a < 0 || b < 0 || !Number.isFinite(size) || !Number.isFinite(start)) return null;
  const chunk = r.stdout.slice(b + 1);
  const text = chunk.slice(0, chunk.lastIndexOf("\n") + 1);
  return { text, start, end: start + utf8Length(text), size };
}
