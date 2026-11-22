import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

type State = { bytes: Buffer; stat: fs.Stats } | undefined;
export interface RoutingCleanupSnapshot {
 /** Original physical bytes (a copy), or undefined for an absent file. */
 read(path: string): Buffer | undefined;
}
const snapshots = new WeakMap<RoutingCleanupSnapshot, Map<string, State>>();
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function inspect(path: string): State {
 let stat: fs.Stats;
 try { stat = fs.lstatSync(path); } catch (e) { if (absent(e)) return; throw e; }
 if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Unsafe routing cleanup file: ${path}`);
 const bytes = fs.readFileSync(path);
 const end = fs.lstatSync(path);
 if (!sameStat(stat, end)) throw new Error(`Routing cleanup input changed: ${path}`);
 return { bytes, stat: end };
}
function sameStat(a: fs.Stats, b: fs.Stats): boolean {
 return b.isFile() && b.nlink === 1 && a.dev === b.dev && a.ino === b.ino &&
  a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function same(a: State, b: State): boolean {
 return a === undefined ? b === undefined : b !== undefined && sameStat(a.stat, b.stat) && a.bytes.equals(b.bytes);
}
/** Capture before selection. Reject linked/nonregular inputs; only ENOENT means absent. */
export function snapshotRoutingCleanup(paths: readonly string[]): RoutingCleanupSnapshot {
 const files = new Map<string, State>();
 for (const input of paths) {
  const path = resolve(input);
  if (files.has(path)) throw new Error(`Duplicate routing cleanup path: ${path}`);
  files.set(path, inspect(path));
 }
 const snapshot = { read: (path: string) => {
  path = resolve(path);
  if (!files.has(path)) throw new Error(`Unknown routing cleanup path: ${path}`);
  const value = files.get(path);
  return value && Buffer.from(value.bytes);
 } };
 snapshots.set(snapshot, files);
 return snapshot;
}

type Prepared = {
 path: string; original: State; replacement: Buffer;
 next?: string; restore?: string; installed?: State; attempted: boolean;
};
export interface RoutingCleanupResult {
 /** Temporary files left behind after a commit that otherwise stands. */
 warnings: string[];
}
/** Prepared runtime compensation, NOT crash recovery, Windows ACL preservation,
 * power-loss atomicity, or isolation from uncooperative writers between checks.
 * Throws when nothing or not everything was committed; once every destination is
 * installed, a temporary file that cannot be removed is returned as a warning. */
export function commitRoutingCleanup(snapshot: RoutingCleanupSnapshot, replacements: ReadonlyMap<string, Uint8Array>): RoutingCleanupResult {
 const files = snapshots.get(snapshot);
 if (!files) throw new Error("Invalid routing cleanup snapshot");
 const work: Prepared[] = [];
 const artifacts = new Set<string>();
 const retained = new Set<string>();
 const issues: string[] = [];
 const warnings: string[] = [];
 const material = (entry: Prepared, kind: string, bytes: Buffer): string => {
  const path = `${entry.path}.cleanup-${kind}-${randomUUID()}`;
  const fd = fs.openSync(path, "wx", 0o600);
  artifacts.add(path);
  try {
   fs.writeFileSync(fd, bytes);
   if (entry.original) fs.fchmodSync(fd, entry.original.stat.mode & 0o777);
  } finally { fs.closeSync(fd); }
  return path;
 };
 let failure: unknown;
 try {
  const seen = new Set<string>();
  const unchanged: string[] = [];
  for (const [input, value] of replacements) {
   const path = resolve(input);
   if (!files.has(path)) throw new Error(`Unknown routing cleanup path: ${path}`);
   if (seen.has(path)) throw new Error(`Duplicate routing cleanup path: ${path}`);
   seen.add(path);
   const original = files.get(path);
   const replacement = Buffer.from(value);
   if (original?.bytes.equals(replacement)) { unchanged.push(path); continue; }
   work.push({ path, original, replacement, attempted: false });
  }
  for (const entry of work) {
   entry.next = material(entry, "next", entry.replacement);
   if (entry.original) entry.restore = material(entry, "restore", entry.original.bytes);
   entry.installed = inspect(entry.next);
  }
  // Check every destination before the first rename; no-op destinations are
  // never rewritten but still must match the capture.
  for (const path of [...unchanged, ...work.map(entry => entry.path)]) {
   if (!same(files.get(path), inspect(path))) throw new Error(`Routing cleanup input changed: ${path}`);
  }
  // Recheck each one right before its rename to catch changes since the preflight.
  for (const entry of work) {
   if (!same(entry.original, inspect(entry.path))) throw new Error(`Routing cleanup input changed: ${entry.path}`);
   entry.attempted = true;
   fs.renameSync(entry.next!, entry.path);
  }
 } catch (e) {
  failure = e;
  for (const entry of [...work].reverse()) {
   if (!entry.attempted) continue;
   try {
    const current = inspect(entry.path);
    if (same(entry.original, current)) continue;
    // A rename can change ctime; compare the prepared inode, mode and bytes.
    const own = entry.installed;
    if (!own || !current || own.stat.dev !== current.stat.dev || own.stat.ino !== current.stat.ino ||
     own.stat.mode !== current.stat.mode || !own.bytes.equals(current.bytes)) {
     throw new Error("Destination independently changed");
    }
    if (entry.original) fs.renameSync(entry.restore!, entry.path);
    else fs.unlinkSync(entry.path);
   } catch (restoreError) {
    if (entry.restore) retained.add(entry.restore);
    issues.push(`Unresolved restore: ${entry.path}; recovery: ${entry.restore ?? "original was absent"}; ${String(restoreError)}`);
   }
  }
 }
 for (const path of artifacts) {
  if (retained.has(path)) continue;
  try { fs.unlinkSync(path); } catch (e) {
   if (!absent(e)) warnings.push(`Cleanup failed: ${path}; ${String(e)}`);
  }
 }
 if (failure !== undefined) {
  const reason = failure instanceof Error ? failure.message : String(failure);
  throw new Error([`Routing cleanup failed: ${reason}`, ...issues, ...warnings].join("\n"), { cause: failure });
 }
 return { warnings };
}
