// Where a Gentle Shell terminal's conversation lives, and how to read only what was added.
//
// SPIKE MAPPING (T1): a terminal is mapped to its session by its folder. The publisher (T4)
// will report the exact session file per terminal; replace `sessionFileFor` then and nothing
// else needs to change. Known gap: several sessions in one folder are ambiguous (the newest
// file wins).

import { readFile, readdir } from "fs/promises";
import { exec, home } from "herdr";

// Gentle Shell's pi agent folder. pi names a session folder after the real path of its cwd.
export const agentDir = () => `${home()}/.gentle-shell/agent`;

// Mirror of pi's getDefaultSessionDirPath (lib/gentle-shell-resume-hint.ts piDefaultSessionDir).
export const sessionDirOf = (realCwd) =>
  `${agentDir()}/sessions/--${realCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

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

// THE mapping: { dir, file } for a terminal (an entry of `terminals()`), or null when it has no
// folder. `file` is the newest `*.jsonl`, null before the first message (names start with an ISO
// timestamp, so the name order is the time order). `real`: the caller's cwd -> real path memo,
// so the folder is resolved once per terminal folder, not every tick.
export async function sessionFileFor(terminal, real = new Map()) {
  const cwd = terminal?.cwd;
  if (!cwd) return null;
  if (!real.has(cwd)) real.set(cwd, await realpath(cwd));
  const dir = sessionDirOf(real.get(cwd));
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return { dir, file: null };
  }
  const newest = names.filter((n) => n.endsWith(".jsonl")).sort().pop();
  return { dir, file: newest ? `${dir}/${newest}` : null };
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

// The complete lines after byte `pos`, and the byte they end at. `text` is null when the file
// shrank or vanished (start over). A half-written last line waits for the next read. Only the
// new bytes are decoded and parsed; the runtime has no ranged read, so the bytes are fetched
// whole (cheap) and sliced.
// `max` caps one slice so a huge first read doesn't stall the UI thread (`more` = call again).
export async function readAfter(file, pos, max = 2 * 1024 * 1024) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    return { text: null, end: 0, more: false };
  }
  if (bytes.length < pos) return { text: null, end: 0, more: false };
  const last = bytes.lastIndexOf(10) + 1;
  let end = pos + max < last ? bytes.lastIndexOf(10, pos + max - 1) + 1 : last;
  if (end <= pos) end = last; // one line longer than max
  if (end <= pos) return { text: "", end: pos, more: false };
  return { text: utf8(bytes.subarray(pos, end)), end, more: end < last };
}
