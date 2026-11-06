import path from "node:path";
// SPDX-FileCopyrightText: 2026 ExoPro. Inspired by @jasonish/pi-prompt-history
// SPDX-License-Identifier: MIT

import fs from "node:fs";

/**
 * Shared atomic JSON writer (design §D3): serialize to a `.tmp` file in the
 * SAME directory as the target, then renameSync it into place — a same-dir
 * rename is atomic on POSIX/APFS, so readers see the old or the new file,
 * never a partial write. Any error returns false and never throws.
 *
 * No fsync: both consumers treat lost writes as derived cache (a lost index
 * rebuilds on the next open; a lost tombstone resurfaces a prompt the user
 * can re-delete), so the per-write fsync cost is not justified — the crash
 * window is documented, not fixed. The staging name is unique per write
 * (`.tmp-<pid>-<ts>`, the same convention as the store.ts writers): the
 * state dir is shared across concurrent pi instances, so a fixed
 * `${filePath}.tmp` would let two writers clobber the same staging file
 * (torn target JSON, spurious rename failures). A failed write unlinks its
 * staging file, so orphaned `.tmp` files do not accumulate.
 */
export function writeJsonAtomic(filePath: string, value: unknown): boolean {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(value), "utf8");
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // staging file never created or already renamed
    }
    return false;
  }
}
