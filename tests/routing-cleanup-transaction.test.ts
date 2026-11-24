import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { snapshotRoutingCleanup, commitRoutingCleanup } from "../lib/routing-cleanup-transaction.ts";

function fixture(t: any) {
 // OS temp, not the worktree: Windows watchers on the repository tree can make
 // a compensating rename fail with a transient EPERM.
 const dir = fs.mkdtempSync(join(tmpdir(), "cleanup-transaction-"));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const paths = Array.from({ length: 4 }, (_, i) => join(dir, `${i}.json`));
 paths.forEach((p, i) => fs.writeFileSync(p, `old${i}`));
 const replacements = new Map(paths.map((p, i) => [p, Buffer.from(`new${i}`)]));
 return { dir, paths, replacements };
}
function original(paths: string[]) {
 paths.forEach((p, i) => assert.equal(fs.readFileSync(p, "utf8"), `old${i}`));
}
test("commits exact bytes, preserves modes, skips no-ops", t => {
 const { dir, paths, replacements } = fixture(t);
 fs.chmodSync(paths[0], 0o640);
 const mode = fs.statSync(paths[0]).mode & 0o777;
 const identity = fs.statSync(paths[1]).ino;
 replacements.set(paths[1], Buffer.from("old1"));
 assert.deepEqual(commitRoutingCleanup(snapshotRoutingCleanup(paths), replacements), { warnings: [] });
 assert.equal(fs.statSync(paths[0]).mode & 0o777, mode);
 assert.equal(fs.statSync(paths[1]).ino, identity);
 paths.forEach(p => assert.deepEqual(fs.readFileSync(p), replacements.get(p)));
 assert.equal(fs.readdirSync(dir).length, 4);
});
for (const after of [false, true]) for (let position = 0; position < 4; position++) {
 test(`commit failure ${position}, after mutation ${after}`, t => {
  const { dir, paths, replacements } = fixture(t);
  const snapshot = snapshotRoutingCleanup(paths);
  const rename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, "renameSync", (from: any, to: any) => {
   if (!failed && to === paths[position]) {
    failed = true;
    if (after) rename(from, to);
    throw new Error("commit fault");
   }
   return rename(from, to);
  });
  assert.throws(() => commitRoutingCleanup(snapshot, replacements), { message: "Routing cleanup failed: commit fault" });
  original(paths);
  assert.equal(fs.readdirSync(dir).length, 4);
 });
}
test("preparation failure leaves all destinations untouched", t => {
 const { dir, paths, replacements } = fixture(t);
 const snapshot = snapshotRoutingCleanup(paths);
 const write = fs.writeFileSync;
 let calls = 0;
 t.mock.method(fs, "writeFileSync", (...args: any[]) => {
  if (++calls === 3) throw new Error("prepare fault");
  return (write as any)(...args);
 });
 assert.throws(() => commitRoutingCleanup(snapshot, replacements), { message: "Routing cleanup failed: prepare fault" });
 original(paths);
 assert.equal(fs.readdirSync(dir).length, 4);
});
test("rejects changed bytes and changed identity before renaming any destination", t => {
 const { dir, paths, replacements } = fixture(t);
 const identities = paths.map(p => fs.statSync(p).ino);
 const rename = fs.renameSync;
 const installs: string[] = [];
 t.mock.method(fs, "renameSync", (from: any, to: any) => {
  if (paths.includes(String(to))) installs.push(String(to));
  return rename(from, to);
 });
 for (const replace of [false, true]) {
  installs.length = 0;
  const snapshot = snapshotRoutingCleanup(paths);
  const bytes = fs.readFileSync(paths[2]);
  let replacement: number | undefined;
  if (replace) {
   // Identical bytes from another file: only the identity check can catch it.
   const outside = join(dir, "outside");
   fs.writeFileSync(outside, bytes);
   replacement = fs.statSync(outside).ino;
   rename(outside, paths[2]);
  } else fs.writeFileSync(paths[2], "external");
  assert.throws(() => commitRoutingCleanup(snapshot, replacements), { message: `Routing cleanup failed: Routing cleanup input changed: ${paths[2]}` });
  assert.deepEqual(installs, []);
  if (replace) {
   assert.deepEqual(fs.readFileSync(paths[2]), bytes);
   assert.equal(fs.statSync(paths[2]).ino, replacement);
  } else assert.equal(fs.readFileSync(paths[2], "utf8"), "external");
  [0, 1, 3].forEach(i => {
   assert.equal(fs.readFileSync(paths[i], "utf8"), `old${i}`);
   assert.equal(fs.statSync(paths[i]).ino, identities[i]);
  });
  assert.equal(fs.readdirSync(dir).length, 4);
 }
});
test("rejects a destination changed after the preflight, before its own rename", t => {
 const { dir, paths, replacements } = fixture(t);
 const snapshot = snapshotRoutingCleanup(paths);
 const rename = fs.renameSync;
 let changed = false;
 t.mock.method(fs, "renameSync", (from: any, to: any) => {
  if (!changed && String(to) === paths[0]) { changed = true; fs.writeFileSync(paths[2], "external"); }
  return rename(from, to);
 });
 assert.throws(() => commitRoutingCleanup(snapshot, replacements), { message: `Routing cleanup failed: Routing cleanup input changed: ${paths[2]}` });
 assert.equal(fs.readFileSync(paths[2], "utf8"), "external");
 [0, 1, 3].forEach(i => assert.equal(fs.readFileSync(paths[i], "utf8"), `old${i}`));
 assert.equal(fs.readdirSync(dir).length, 4);
});
test("rejects a no-op destination that changed after capture", t => {
 const { dir, paths, replacements } = fixture(t);
 replacements.set(paths[2], Buffer.from("old2"));
 const snapshot = snapshotRoutingCleanup(paths);
 fs.writeFileSync(paths[2], "external");
 assert.throws(() => commitRoutingCleanup(snapshot, replacements), { message: `Routing cleanup failed: Routing cleanup input changed: ${paths[2]}` });
 assert.equal(fs.readFileSync(paths[2], "utf8"), "external");
 [0, 1, 3].forEach(i => assert.equal(fs.readFileSync(paths[i], "utf8"), `old${i}`));
 assert.equal(fs.readdirSync(dir).length, 4);
});
test("rollback removes a newly created original", t => {
 const { dir, paths, replacements } = fixture(t);
 fs.unlinkSync(paths[0]);
 const snapshot = snapshotRoutingCleanup(paths);
 const rename = fs.renameSync;
 t.mock.method(fs, "renameSync", (a: any, b: any) => {
  if (b === paths[1]) throw new Error("fault");
  return rename(a, b);
 });
 assert.throws(() => commitRoutingCleanup(snapshot, replacements), /Routing cleanup failed: fault/);
 assert.equal(fs.existsSync(paths[0]), false);
 assert.equal(fs.readdirSync(dir).length, 3);
});
test("rollback continues, preserves recovery bytes and independent edits", t => {
 const { dir, paths, replacements } = fixture(t);
 const snapshot = snapshotRoutingCleanup(paths);
 const rename = fs.renameSync;
 let rolling = false;
 t.mock.method(fs, "renameSync", (a: any, b: any) => {
  if (!rolling && b === paths[3]) {
   rolling = true;
   fs.writeFileSync(paths[1], "external");
   throw new Error("commit fault");
  }
  if (rolling && b === paths[2]) throw new Error("restore fault");
  return rename(a, b);
 });
 let error: Error | undefined;
 try { commitRoutingCleanup(snapshot, replacements); } catch (e) { error = e as Error; }
 assert.ok(error?.message.startsWith("Routing cleanup failed: commit fault"));
 assert.ok(error.message.includes(`Unresolved restore: ${paths[2]}`));
 assert.ok(error.message.includes(`Unresolved restore: ${paths[1]}`));
 assert.equal(fs.readFileSync(paths[0], "utf8"), "old0");
 assert.equal(fs.readFileSync(paths[1], "utf8"), "external");
 assert.equal(fs.readFileSync(paths[2], "utf8"), "new2");
 const recovery = fs.readdirSync(dir).filter(p => p.includes("restore"));
 assert.equal(recovery.length, 2);
 assert.deepEqual(recovery.map(p => fs.readFileSync(join(dir, p), "utf8")).sort(), ["old1", "old2"]);
});
test("rejects hardlinks and nonregular files without touching peers", t => {
 const { dir, paths } = fixture(t);
 fs.linkSync(paths[0], join(dir, "alias"));
 assert.throws(() => snapshotRoutingCleanup(paths), { message: `Unsafe routing cleanup file: ${paths[0]}` });
 assert.throws(() => snapshotRoutingCleanup([dir]), { message: `Unsafe routing cleanup file: ${dir}` });
 original(paths);
});
for (const preparation of [false, true]) test(`reports temporary cleanup failure, preparation ${preparation}`, t => {
 const { dir, paths, replacements } = fixture(t);
 const snapshot = snapshotRoutingCleanup(paths);
 const unlink = fs.unlinkSync;
 t.mock.method(fs, "unlinkSync", (p: any) => {
  if (String(p).includes("restore")) throw new Error("cleanup fault");
  return unlink(p);
 });
 if (preparation) {
  const write = fs.writeFileSync;
  let calls = 0;
  t.mock.method(fs, "writeFileSync", (...args: any[]) => {
   if (++calls === 3) throw new Error("prepare fault");
   return (write as any)(...args);
  });
 }
 const leftovers = () => fs.readdirSync(dir).filter(p => p.includes("restore")).map(p => join(dir, p));
 if (preparation) {
  let error: Error | undefined;
  try { commitRoutingCleanup(snapshot, replacements); } catch (e) { error = e as Error; }
  assert.ok(error?.message.startsWith("Routing cleanup failed: prepare fault"));
  assert.ok(error.message.includes("Cleanup failed:"));
  assert.ok(error.message.includes("cleanup fault"));
  original(paths);
  assert.ok(leftovers().length > 0);
  return;
 }
 // Every rename succeeded: the commit stands and leftover removal is only a warning.
 const result = commitRoutingCleanup(snapshot, replacements);
 paths.forEach((p, i) => assert.equal(fs.readFileSync(p, "utf8"), `new${i}`));
 const left = leftovers();
 assert.equal(left.length, 4);
 assert.deepEqual([...result.warnings].sort(), left.map(p => `Cleanup failed: ${p}; Error: cleanup fault`).sort());
});
test("snapshot bytes are copies and non-ENOENT inspection errors propagate", t => {
 const { paths } = fixture(t);
 const snapshot = snapshotRoutingCleanup(paths);
 snapshot.read(paths[0])!.fill(0);
 assert.equal(snapshot.read(paths[0])!.toString(), "old0");
 const stat = fs.lstatSync;
 t.mock.method(fs, "lstatSync", (p: any) => {
  if (p === paths[1]) throw Object.assign(new Error("denied"), { code: "EACCES" });
  return stat(p);
 });
 assert.throws(() => snapshotRoutingCleanup(paths), { message: "denied" });
 original(paths);
});
test("rejects symlinks (when platform permits creating them)", t => {
 const { dir, paths } = fixture(t);
 const link = join(dir, "link");
 try { fs.symlinkSync(paths[0], link); } catch (e: any) {
  if (e.code === "EPERM") { t.skip("Symlink privilege unavailable"); return; }
  throw e;
 }
 assert.throws(() => snapshotRoutingCleanup([link]), { message: `Unsafe routing cleanup file: ${link}` });
 original(paths);
});
