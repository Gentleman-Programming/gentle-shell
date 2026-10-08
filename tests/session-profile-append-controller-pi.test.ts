// Public SessionManager fixtures only. Retain isolated data for parent evidence.
import assert from "node:assert/strict";
import {
 existsSync,
 mkdirSync,
 mkdtempSync,
 readFileSync,
 renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
 createSessionProfileBind,
 SESSION_PROFILE_CUSTOM_TYPE,
} from "../lib/session-profile-persistence.ts";
import {
 createSessionProfileAppendController,
 type SessionProfileAppendOutcome,
} from "../lib/session-profile-append-controller.ts";

const metadata = join(
 dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
 "..",
 "package.json",
);
const version: string = JSON.parse(readFileSync(metadata, "utf8")).version;
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.ok(
 Number(version.split(".")[0]) >= 1,
 `Public fixtures require Pi >=1.0.0, installed ${version}`,
);
console.info(
 `Public append controller fixture API: ${version}; minimum tested baseline 1.0.0`,
);
function controller(manager: SessionManager, errors: unknown[] = []) {
 // Extension appendEntry is void; the actual public manager's ID is ignored.
 return createSessionProfileAppendController(manager, (type, data): void => {
  try {
   manager.appendCustomEntry(type, data);
  } catch (error) {
   errors.push(error);
   throw error;
  }
 });
}
function fixture() {
 const root = mkdtempSync(join(tmpdir(), "profile-append-pi-"));
 const sessions = join(root, "sessions");
 const manager = SessionManager.create(root, sessions);
 const errors: unknown[] = [];
 return { manager, sessions, errors, adapter: controller(manager, errors) };
}
function flush(manager: SessionManager) {
 // Ordinary test-owned conversation fixture, never a production workaround.
 manager.appendMessage({
  role: "user",
  content: "isolated append controller fixture",
  timestamp: Date.now(),
 });
}
function bound(result: SessionProfileAppendOutcome, name: string) {
 assert.equal(result.state.status, "bound");
 if (result.state.status !== "bound")
  throw new Error("Expected bound authority");
 assert.equal(result.state.binding.name, name);
 return result.state.binding;
}
for (const operation of ["bind", "clear"] as const) {
 test(`public explicit custom-only ${operation} reports preflush, normal fixture flush upgrades exact record`, () => {
  const { manager, adapter } = fixture();
  // isPersisted() is configuration, not a first-flush witness.
  assert.equal(manager.isPersisted(), true);
  const first =
   operation === "bind" ? adapter.bind("initial", {}) : adapter.clear();
  assert.equal(first.status, "not-persisted");
  assert.equal(first.state.status, operation === "bind" ? "bound" : "cleared");
  const file = manager.getSessionFile();
  assert.ok(file);
  assert.equal(existsSync(file), false);
  assert.equal(adapter.refresh().status, "not-persisted");
  assert.equal(controller(manager).refresh().status, "indeterminate");
  const selected = manager.getBranch().at(-1);
  assert.ok(selected);
  flush(manager);
  const persisted = adapter.refresh();
  assert.equal(persisted.status, "persisted");
  assert.equal(
   persisted.state.status,
   operation === "bind" ? "bound" : "cleared",
  );
  const disk = readFileSync(file, "utf8")
   .trim()
   .split("\n")
   .map((line) => JSON.parse(line));
  assert.deepEqual(
   disk.find((row) => row.id === selected.id),
   JSON.parse(JSON.stringify(selected)),
  );
 });
}
for (const prior of ["bound", "invalid", "future"] as const) {
 for (const operation of ["bind", "clear"] as const) {
  test(`public NEW ${operation} over unwritten ${prior} is not restoration or first-flush proof`, () => {
   const { manager } = fixture();
   manager.appendCustomEntry(
    prior === "future"
     ? "gentle-pi.session-profile/v2"
     : SESSION_PROFILE_CUSTOM_TYPE,
    prior === "bound" ? createSessionProfileBind("unwritten", {}) : {},
   );
   const file = manager.getSessionFile();
   assert.ok(file);
   assert.equal(existsSync(file), false);
   const adapter = controller(manager);
   assert.equal(adapter.refresh().status, "indeterminate");
   const result =
    operation === "bind" ? adapter.bind("NEW", {}) : adapter.clear();
   assert.equal(result.status, "not-persisted");
   assert.equal(
    result.state.status,
    operation === "bind" ? "bound" : "cleared",
   );
   if (operation === "bind") bound(result, "NEW");
   assert.equal(adapter.refresh().status, "not-persisted");
   assert.equal(controller(manager).refresh().status, "indeterminate");
   const selected = manager.getBranch().at(-1);
   assert.ok(selected);
   flush(manager);
   assert.equal(adapter.refresh().status, "persisted");
   assert.equal(
    controller(manager).refresh().state.status,
    operation === "bind" ? "bound" : "cleared",
   );
   const disk = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
   assert.deepEqual(
    disk.find((row) => row.id === selected.id),
    JSON.parse(JSON.stringify(selected)),
   );
  });
 }
}
for (const failure of ["bind", "clear"] as const) {
 for (const recovery of ["bind", "clear"] as const) {
  test(`public EISDIR failed ${failure} never adopted; new ${recovery} survives orphan-parent reopen`, () => {
   const { manager, sessions, adapter, errors } = fixture();
   assert.equal(
    adapter.bind("good", {
     worker: { model: "offline/good" },
     orchestrator: { model: "offline/preserved" },
    }).status,
    "not-persisted",
   );
   flush(manager);
   bound(adapter.refresh(), "good");
   const file = manager.getSessionFile();
   assert.ok(file);
   const saved = `${file}.saved`;
   renameSync(file, saved);
   mkdirSync(file);
   const failed =
    failure === "bind" ? adapter.bind("failed", {}) : adapter.clear();
   assert.equal(failed.status, "indeterminate");
   assert.equal(errors.length, 1);
   assert.equal((errors[0] as NodeJS.ErrnoException).code, "EISDIR");
   const ghost = manager.getBranch().at(-1);
   assert.ok(ghost);
   assert.equal(ghost.type, "custom");
   // Recover fixture filesystem by moves, not history edits or private APIs.
   renameSync(file, `${file}.fault-directory`);
   renameSync(saved, file);
   const preserved = adapter.refresh();
   assert.equal(preserved.status, "persisted");
   bound(preserved, "good");
   const branch = manager.getBranch();
   const good = branch.find(
    (entry) => entry.type === "custom" && entry.id !== ghost.id,
   );
   assert.ok(good);
   manager.branch(good.id);
   bound(adapter.refresh(), "good");
   manager.branch(ghost.id);
   bound(adapter.refresh(), "good");
   const recovered =
    recovery === "bind" ? adapter.bind("recovered", {}) : adapter.clear();
   assert.equal(recovered.status, "persisted");
   assert.equal(
    recovered.state.status,
    recovery === "bind" ? "bound" : "cleared",
   );
   const latest = manager.getBranch().at(-1);
   assert.ok(latest);
   assert.equal(latest.parentId, ghost.id);
   const disk = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
   assert.equal(
    disk.some((row) => row.id === ghost.id),
    false,
   );
   assert.deepEqual(
    disk.find((row) => row.id === latest.id),
    JSON.parse(JSON.stringify(latest)),
   );
   const reopened = SessionManager.open(file, sessions);
   const restored = controller(reopened).refresh();
   assert.equal(restored.status, "persisted");
   assert.equal(
    restored.state.status,
    recovery === "bind" ? "bound" : "cleared",
   );
   // Pi truncates the resumed branch at the missing failed parent. The new
   // selected record is valid authority without history repair/full ancestry.
   assert.equal(reopened.getBranch().length, 1);
   assert.equal(
    reopened.getBranch().some((entry) => entry.id === ghost.id),
    false,
   );
   assert.equal(reopened.getBranch().at(-1)?.id, latest.id);
   manager.branch(ghost.id);
   bound(adapter.refresh(), "good");
  });
 }
}
test("public sibling disk records never override the selected active branch", () => {
 const { manager, adapter } = fixture();
 adapter.bind("base", {});
 flush(manager);
 const base = manager.getLeafId();
 assert.ok(base);
 assert.equal(adapter.bind("left", {}).status, "persisted");
 const left = manager.getLeafId();
 assert.ok(left);
 manager.branch(base);
 assert.equal(adapter.bind("right", {}).status, "persisted");
 bound(adapter.refresh(), "right");
 manager.branch(left);
 bound(adapter.refresh(), "left");
 const other = fixture();
 assert.equal(other.adapter.refresh().status, "indeterminate");
});

for (const failedOperation of ["bind", "clear"] as const) {
 test(`public EISDIR ${failedOperation} quarantine survives detach and fresh append capability`, () => {
  const f = fixture();
  f.adapter.bind("trusted", {});
  flush(f.manager);
  const file = f.manager.getSessionFile();
  assert.ok(file);
  const original = readFileSync(file, "utf8");
  renameSync(file, `${file}.saved`);
  mkdirSync(file);
  const failed =
   failedOperation === "bind"
    ? f.adapter.bind("FAILED", {})
    : f.adapter.clear();
  assert.equal(failed.status, "indeterminate");
  assert.equal(readFileSync(`${file}.saved`, "utf8"), original);
  const ghost = f.manager.getLeafId();
  assert.ok(ghost);
  renameSync(file, `${file}.fault-directory`);
  renameSync(`${file}.saved`, file);
  f.adapter.detach();
  let calls = 0;
  const current = f.adapter.attach(
   f.manager,
   (t, d) => {
    calls++;
    f.manager.appendCustomEntry(t, d);
   },
   { reason: "reload" },
  );
  bound(current.refresh(), "trusted");
  const length = f.manager.getBranch().length;
  assert.equal(f.adapter.bind("stale", {}).status, "indeterminate");
  assert.equal(f.manager.getBranch().length, length);
  assert.equal(calls, 0);
  assert.equal(current.clear().status, "persisted");
  assert.equal(calls, 1);
  f.manager.branch(ghost);
  bound(current.refresh(), "trusted");
  assert.equal(f.errors.length, 1);
 });
}
