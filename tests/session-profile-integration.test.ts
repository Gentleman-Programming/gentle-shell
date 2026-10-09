import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
 AgentSessionRuntime,
 SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createSessionProfileIntegration } from "../lib/session-profile-integration.ts";

const version = JSON.parse(
 readFileSync(
  join(
   dirname(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
   ),
   "..",
   "package.json",
  ),
  "utf8",
 ),
).version;
assert.ok(
 Number(version.split(".")[0]) >= 1,
 "Lifecycle public fixtures require Pi >=1.0.0",
);
console.info(`Public lifecycle fixture API: ${version}`);
function fixture(memory = false) {
 const root = mkdtempSync(join(tmpdir(), "profile-lifecycle-"));
 const manager = memory
  ? SessionManager.inMemory(root)
  : SessionManager.create(root, join(root, "sessions"));
 return {
  manager,
  integration: createSessionProfileIntegration(),
  append: (type: string, data: unknown): void => {
   manager.appendCustomEntry(type, data);
  },
 };
}
function flush(manager: SessionManager) {
 manager.appendMessage({
  role: "user",
  content: "isolated lifecycle fixture",
  timestamp: 1,
 });
}
function name(outcome: { state: unknown }, expected: string) {
 const state = outcome.state as { status: string; binding?: { name: string } };
 assert.equal(state.status, "bound");
 assert.equal(state.binding?.name, expected);
}
function persistedCopy(manager: SessionManager, leaf: string) {
 const sourceFile = manager.getSessionFile();
 assert.ok(sourceFile);
 const copy = SessionManager.open(sourceFile, manager.getSessionDir());
 copy.createBranchedSession(leaf);
 return copy;
}
for (const operation of ["bind", "clear"] as const) {
 test(`reload revokes unwritten ${operation} and old capability; later nonfailed disk restoration remains valid`, () => {
  const f = fixture();
  let oldCalls = 0,
   newCalls = 0;
  const initial = f.integration.start(
   f.manager,
   (t, d) => {
    oldCalls++;
    f.append(t, d);
   },
   { reason: "startup" },
  );
  const selected =
   operation === "bind"
    ? initial.attachment.bind("pending", {})
    : initial.attachment.clear();
  assert.equal(selected.status, "not-persisted");
  f.integration.shutdown(f.manager, { reason: "reload" });
  assert.equal(initial.attachment.refresh().status, "indeterminate");
  assert.equal(initial.attachment.bind("stale", {}).status, "indeterminate");
  assert.equal(oldCalls, 1);
  const reloadedModule = createSessionProfileIntegration();
  const current = reloadedModule.start(
   f.manager,
   (t, d) => {
    newCalls++;
    f.append(t, d);
   },
   { reason: "reload" },
  );
  assert.equal(current.outcome.status, "indeterminate");
  assert.equal(newCalls, 0);
  flush(f.manager);
  const restored = reloadedModule.tree(f.manager);
  assert.equal(restored.status, "persisted");
  assert.equal(
   restored.state.status,
   operation === "bind" ? "bound" : "cleared",
  );
  if (operation === "bind") name(restored, "pending");
  assert.equal(current.attachment.bind("current", {}).status, "persisted");
  assert.equal(newCalls, 1);
  assert.equal(oldCalls, 1);
  // A handler owned by the invalidated adapter cannot detach the new epoch.
  f.integration.shutdown(f.manager, { reason: "reload" });
  name(current.attachment.refresh(), "current");
 });
}
for (const reader of ["replacement", "default"] as const) {
 test(`reload replaces optional readFile with ${reader} and never calls the retired reader`, () => {
  const f = fixture();
  flush(f.manager);
  let oldReads = 0,
   currentReads = 0,
   oldAppends = 0,
   currentAppends = 0;
  const previous = createSessionProfileIntegration({
   readFile: (file) => {
    oldReads++;
    return readFileSync(file, "utf8");
   },
  });
  const initial = previous.start(
   f.manager,
   (type, data) => {
    oldAppends++;
    f.append(type, data);
   },
   { reason: "startup" },
  );
  assert.equal(initial.attachment.bind("trusted", {}).status, "persisted");
  assert.ok(oldReads > 0, "initial factory options still read disk");
  previous.shutdown(f.manager, { reason: "reload" });
  const frozenReads = oldReads;
  const frozenEntries = f.manager.getEntries().length;
  assert.equal(initial.attachment.refresh().status, "indeterminate");
  assert.equal(initial.attachment.clear().status, "indeterminate");
  assert.equal(f.manager.getEntries().length, frozenEntries);
  assert.equal(oldReads, frozenReads);
  const current = createSessionProfileIntegration(
   reader === "replacement"
    ? {
       readFile: (file) => {
        currentReads++;
        return readFileSync(file, "utf8");
       },
      }
    : {},
  );
  const started = current.start(
   f.manager,
   (type, data) => {
    currentAppends++;
    f.append(type, data);
   },
   { reason: "reload" },
  );
  assert.equal(started.outcome.status, "persisted");
  name(started.outcome, "trusted");
  assert.equal(
   oldReads,
   frozenReads,
   "reload must not invoke the retired readFile",
  );
  assert.equal(currentReads > 0, reader === "replacement");
  assert.equal(currentAppends, 0);
  assert.equal(started.attachment.bind("current", {}).status, "persisted");
  assert.equal(started.attachment.clear().status, "persisted");
  assert.equal(f.manager.getEntries().length, frozenEntries + 2);
  assert.equal(currentAppends, 2);
  assert.equal(oldAppends, 1);
  const frozenCurrentReads = currentReads;
  previous.shutdown(f.manager, { reason: "reload" });
  assert.equal(previous.tree(f.manager).status, "indeterminate");
  assert.equal(initial.attachment.bind("stale", {}).status, "indeterminate");
  assert.equal(currentReads, frozenCurrentReads);
  assert.equal(f.manager.getEntries().length, frozenEntries + 2);
  assert.equal(started.attachment.refresh().state.status, "cleared");
  assert.equal(oldReads, frozenReads);
 });
}
function failedThenFlushed() {
 const f = fixture();
 const initial = f.integration.start(
  f.manager,
  (t, d) => {
   f.append(t, d);
   throw new Error("injected callback failure after public custom append");
  },
  { reason: "startup" },
 );
 assert.equal(initial.attachment.bind("failed", {}).status, "indeterminate");
 const failed = f.manager.getLeafId();
 assert.ok(failed);
 assert.equal(existsSync(f.manager.getSessionFile()!), false);
 // Genuine public first flush now writes the known-failed record as well.
 flush(f.manager);
 return { ...f, initial, failed };
}
test("reload retains failed quarantine after genuine first flush", () => {
 const f = failedThenFlushed();
 f.integration.shutdown(f.manager, { reason: "reload" });
 const current = createSessionProfileIntegration().start(f.manager, f.append, {
  reason: "reload",
 });
 assert.equal(current.outcome.state.status, "absent");
 assert.equal(current.attachment.clear().status, "persisted");
 f.manager.branch(f.failed);
 assert.equal(current.attachment.refresh().state.status, "absent");
});
test("confirmed persisted disk-first fork retains copied failure but does not inherit binding", () => {
 const f = failedThenFlushed();
 const previousSessionFile = f.manager.getSessionFile();
 assert.equal(
  f.integration.beforeFork(f.manager, { entryId: f.failed, position: "at" })
   .status,
  "captured",
 );
 const copy = persistedCopy(f.manager, f.failed);
 assert.notEqual(copy, f.manager);
 f.integration.shutdown(f.manager, {
  reason: "fork",
  targetSessionFile: copy.getSessionFile(),
 });
 const current = createSessionProfileIntegration().start(
  copy,
  (t, d) => {
   copy.appendCustomEntry(t, d);
  },
  { reason: "fork", previousSessionFile },
 );
 // This copied path has no conversation: even a saved parent does not prove
 // that the new child file exists. Quarantine must survive its later flush.
 assert.equal(current.outcome.status, "indeterminate");
 assert.equal(existsSync(copy.getSessionFile()!), false);
 flush(copy);
 assert.equal(current.attachment.refresh().state.status, "absent");
 assert.equal(current.attachment.clear().status, "persisted");
 const replay = createSessionProfileIntegration().start(
  copy,
  (t, d) => {
   copy.appendCustomEntry(t, d);
  },
  { reason: "fork", previousSessionFile },
 );
 assert.equal(replay.outcome.status, "indeterminate");
});
test("S5 rejects actual copied cut beyond prepared ancestor", () => {
 const f = fixture();
 flush(f.manager);
 let fail = false,
  sourceAppends = 0,
  childAppends = 0;
 const live = f.integration.start(
  f.manager,
  (type, data) => {
   sourceAppends++;
   f.append(type, data);
   if (fail)
    throw new Error("injected callback failure after public disk append");
  },
  { reason: "startup" },
 );
 assert.equal(live.attachment.bind("trusted", {}).status, "persisted");
 const preparedCut = f.manager.getLeafId();
 assert.ok(preparedCut);
 fail = true;
 const failed = live.attachment.bind("known-failed", {});
 assert.equal(failed.status, "append-failed-preserved");
 name(failed, "trusted");
 name(live.attachment.refresh(), "trusted");
 const actualCut = f.manager.getLeafId();
 assert.ok(actualCut);
 assert.notEqual(actualCut, preparedCut);
 const sourceFile = f.manager.getSessionFile();
 assert.ok(sourceFile);
 const sourceEntries = JSON.stringify(f.manager.getEntries());
 const sourceDisk = readFileSync(sourceFile, "utf8");
 assert.equal(
  f.integration.beforeFork(f.manager, { entryId: preparedCut, position: "at" })
   .status,
  "captured",
 );
 const child = persistedCopy(f.manager, actualCut);
 assert.equal(child.getLeafId(), actualCut);
 assert.ok(child.getBranch().some((entry) => entry.id === preparedCut));
 assert.ok(child.getBranch().some((entry) => entry.id === actualCut));
 const childFile = child.getSessionFile();
 assert.ok(childFile);
 const childEntries = JSON.stringify(child.getEntries());
 const childDisk = readFileSync(childFile, "utf8");
 assert.ok(
  childDisk.includes(actualCut),
  "actual public copy stores the failed record",
 );
 f.integration.shutdown(f.manager, {
  reason: "fork",
  targetSessionFile: childFile,
 });
 assert.equal(live.attachment.clear().status, "indeterminate");
 const started = createSessionProfileIntegration().start(
  child,
  (type, data) => {
   childAppends++;
   child.appendCustomEntry(type, data);
  },
  { reason: "fork", previousSessionFile: sourceFile },
 );
 assert.deepEqual(started.outcome, {
  status: "indeterminate",
  state: { status: "indeterminate", reason: "ambiguous-append" },
 });
 assert.deepEqual(started.attachment.refresh(), started.outcome);
 assert.equal(childAppends, 0);
 assert.equal(sourceAppends, 2);
 assert.equal(JSON.stringify(child.getEntries()), childEntries);
 assert.equal(readFileSync(childFile, "utf8"), childDisk);
 assert.equal(JSON.stringify(f.manager.getEntries()), sourceEntries);
 assert.equal(readFileSync(sourceFile, "utf8"), sourceDisk);
});
for (const position of ["before", "at"] as const) {
 test(`cancelled ${position} fork leaves explicit activation and callbacks unchanged`, () => {
  const f = fixture();
  let calls = 0;
  const current = f.integration.start(
   f.manager,
   (t, d) => {
    calls++;
    f.append(t, d);
   },
   { reason: "startup" },
  );
  assert.equal(current.attachment.bind("pending", {}).status, "not-persisted");
  const leaf = f.manager.getLeafId();
  assert.ok(leaf);
  const target = position === "at" ? leaf : "missing";
  const before = JSON.stringify(f.manager.getEntries());
  const proposed = f.integration.beforeFork(f.manager, {
   entryId: target,
   position,
  });
  assert.equal(
   proposed.status,
   position === "at" ? "captured" : "indeterminate",
  );
  assert.equal(JSON.stringify(f.manager.getEntries()), before);
  assert.equal(current.attachment.refresh().status, "not-persisted");
  assert.equal(current.attachment.bind("next", {}).status, "not-persisted");
  assert.equal(calls, 2);
 });
}
test("label removal permits only the expected copied parentId rechain", () => {
 const f = fixture();
 const current = f.integration.start(f.manager, f.append, {
  reason: "startup",
 });
 current.attachment.bind("base", {});
 flush(f.manager);
 const base = f.manager.getLeafId();
 assert.ok(base);
 f.manager.appendLabelChange(base, "fixture-label");
 current.attachment.bind("selected", {});
 const leaf = f.manager.getLeafId();
 assert.ok(leaf);
 const original = f.manager.getEntry(leaf)!;
 assert.equal(
  f.integration.beforeFork(f.manager, { entryId: leaf, position: "at" }).status,
  "captured",
 );
 const copy = persistedCopy(f.manager, leaf);
 assert.notEqual(copy.getEntry(leaf)?.parentId, original.parentId);
 f.integration.shutdown(f.manager, {
  reason: "fork",
  targetSessionFile: copy.getSessionFile(),
 });
 const restored = createSessionProfileIntegration().start(
  copy,
  (t, d) => {
   copy.appendCustomEntry(t, d);
  },
  { reason: "fork", previousSessionFile: f.manager.getSessionFile() },
 );
 name(restored.outcome, "selected");
});
test("actual fork path excludes failed sibling and never imports its quarantine", () => {
 const f = fixture();
 let fail = false;
 const live = f.integration.start(
  f.manager,
  (t, d) => {
   f.append(t, d);
   if (fail) throw new Error("injected failure");
  },
  { reason: "startup" },
 );
 live.attachment.bind("base", {});
 flush(f.manager);
 const base = f.manager.getLeafId();
 assert.ok(base);
 fail = true;
 live.attachment.bind("failed-left", {});
 const failed = f.manager.getLeafId();
 fail = false;
 f.manager.branch(base);
 live.attachment.bind("right", {});
 const right = f.manager.getLeafId();
 assert.ok(right);
 assert.notEqual(right, failed);
 assert.equal(
  f.integration.beforeFork(f.manager, { entryId: right, position: "at" })
   .status,
  "captured",
 );
 const copy = persistedCopy(f.manager, right);
 assert.equal(
  copy.getBranch().some((e) => e.id === failed),
  false,
 );
 f.integration.shutdown(f.manager, {
  reason: "fork",
  targetSessionFile: copy.getSessionFile(),
 });
 name(
  createSessionProfileIntegration().start(
   copy,
   (t, d) => {
    copy.appendCustomEntry(t, d);
   },
   { reason: "fork", previousSessionFile: f.manager.getSessionFile() },
  ).outcome,
  "right",
 );
});
for (const changed of ["data", "timestamp", "parentId", "extra"] as const) {
 test(`copied same-ID ${changed} mutation fails closed without blessing destination disk`, () => {
  const f = fixture();
  const live = f.integration.start(f.manager, f.append, { reason: "startup" });
  flush(f.manager);
  live.attachment.bind("trusted", {});
  const leaf = f.manager.getLeafId();
  assert.ok(leaf);
  assert.equal(
   f.integration.beforeFork(f.manager, { entryId: leaf, position: "at" })
    .status,
   "captured",
  );
  const copy = persistedCopy(f.manager, leaf);
  const row = copy.getEntry(leaf)! as unknown as Record<string, any>;
  if (changed === "data") row.data.name = "FAILED";
  if (changed === "timestamp") row.timestamp = "changed";
  if (changed === "parentId") row.parentId = "unexpected-parent";
  if (changed === "extra") row.extra = { changed: true };
  f.integration.shutdown(f.manager, {
   reason: "fork",
   targetSessionFile: copy.getSessionFile(),
  });
  const current = createSessionProfileIntegration({
   // Inject matching disk content as in F2, not ordinary Pi ID reuse.
   readFile: (path) =>
    path === copy.getSessionFile()
     ? [copy.getHeader(), ...copy.getEntries()]
        .map((e) => JSON.stringify(e))
        .join("\n")
     : readFileSync(path, "utf8"),
  }).start(
   copy,
   (t, d) => {
    copy.appendCustomEntry(t, d);
   },
   { reason: "fork", previousSessionFile: f.manager.getSessionFile() },
  );
  assert.equal(current.outcome.status, "indeterminate");
  assert.equal(current.attachment.clear().status, "persisted");
  copy.branch(leaf);
  assert.equal(current.attachment.refresh().status, "indeterminate");
  // Structural source + injected matching disk, never a production rewrite.
 });
}
test("in-memory confirmed fork keeps same-manager evidence but never restores pending state", () => {
 const f = fixture(true);
 const live = f.integration.start(f.manager, f.append, { reason: "startup" });
 live.attachment.bind("pending", {});
 const leaf = f.manager.getLeafId();
 assert.ok(leaf);
 assert.equal(
  f.integration.beforeFork(f.manager, { entryId: leaf, position: "at" }).status,
  "captured",
 );
 f.integration.shutdown(f.manager, { reason: "fork" });
 f.manager.createBranchedSession(leaf);
 const current = createSessionProfileIntegration().start(f.manager, f.append, {
  reason: "fork",
 });
 assert.equal(current.outcome.status, "indeterminate");
 assert.equal(
  current.attachment.bind("new-explicit", {}).status,
  "not-persisted",
 );
 assert.equal(live.attachment.clear().status, "indeterminate");
});
test("fork before root creates empty child without parent binding or established-history transfer", () => {
 const f = fixture();
 flush(f.manager);
 const firstUser = f.manager.getLeafId();
 assert.ok(firstUser);
 const live = f.integration.start(f.manager, f.append, { reason: "startup" });
 live.attachment.bind("parent", {});
 assert.equal(
  f.integration.beforeFork(f.manager, {
   entryId: firstUser,
   position: "before",
  }).status,
  "captured",
 );
 const previousSessionFile = f.manager.getSessionFile();
 const child = SessionManager.create(
  f.manager.getCwd(),
  f.manager.getSessionDir(),
 );
 child.newSession({ parentSession: previousSessionFile });
 f.integration.shutdown(f.manager, {
  reason: "fork",
  targetSessionFile: child.getSessionFile(),
 });
 const current = createSessionProfileIntegration().start(
  child,
  (t, d) => {
   child.appendCustomEntry(t, d);
  },
  { reason: "fork", previousSessionFile },
 );
 assert.equal(current.outcome.status, "indeterminate");
 assert.equal(current.attachment.bind("child", {}).status, "not-persisted");
});
test("distinct manager cannot inherit another manager's pending activation", () => {
 const f = fixture();
 f.integration
  .start(f.manager, f.append, { reason: "startup" })
  .attachment.bind("pending", {});
 const other = fixture();
 assert.equal(
  createSessionProfileIntegration().start(other.manager, other.append, {
   reason: "startup",
  }).outcome.status,
  "indeterminate",
 );
});
test("valid cancelled before-user fork leaves disk, public entries and explicit binding unchanged", () => {
 const f = fixture();
 flush(f.manager);
 const user = f.manager.getLeafId();
 assert.ok(user);
 let calls = 0;
 const live = f.integration.start(
  f.manager,
  (t, d) => {
   calls++;
   f.append(t, d);
  },
  { reason: "startup" },
 );
 live.attachment.bind("current", {});
 const entries = JSON.stringify(f.manager.getEntries());
 const disk = readFileSync(f.manager.getSessionFile()!, "utf8");
 assert.equal(
  f.integration.beforeFork(f.manager, { entryId: user, position: "before" })
   .status,
  "captured",
 );
 assert.equal(JSON.stringify(f.manager.getEntries()), entries);
 assert.equal(readFileSync(f.manager.getSessionFile()!, "utf8"), disk);
 name(live.attachment.refresh(), "current");
 assert.equal(calls, 1);
});
test("public runtime rejects unsaved persisted fork before teardown and preserves explicit selection", async () => {
 const f = fixture();
 const live = f.integration.start(f.manager, f.append, { reason: "startup" });
 live.attachment.bind("pending", {});
 const leaf = f.manager.getLeafId();
 assert.ok(leaf);
 const before = JSON.stringify(f.manager.getEntries());
 let teardown = 0,
  creations = 0;
 const host = {
  sessionManager: f.manager,
  sessionFile: f.manager.getSessionFile(),
  extensionRunner: {
   hasHandlers: () => true,
   emit: async (event: { entryId: string; position: "before" | "at" }) => {
    assert.equal(f.integration.beforeFork(f.manager, event).status, "captured");
   },
  },
  abort: async () => {
   teardown++;
  },
  dispose: () => {
   teardown++;
  },
 };
 const runtime = new AgentSessionRuntime(
  host as unknown as ConstructorParameters<typeof AgentSessionRuntime>[0],
  { cwd: f.manager.getCwd() } as ConstructorParameters<
   typeof AgentSessionRuntime
  >[1],
  async () => {
   creations++;
   throw new Error("fixture must never create runtime");
  },
 );
 await assert.rejects(runtime.fork(leaf, { position: "at" }), {
  message:
   "This session has not been saved yet. Send a message before cloning or forking it.",
 });
 assert.equal(teardown, 0);
 assert.equal(creations, 0);
 assert.equal(JSON.stringify(f.manager.getEntries()), before);
 assert.equal(existsSync(f.manager.getSessionFile()!), false);
 assert.equal(live.attachment.refresh().status, "not-persisted");
});
for (const incompatible of [false, true]) {
 test(`isolated process ${incompatible ? "rejects incompatible owner protocol" : "cannot inherit the live registry"}`, () => {
  const root = mkdtempSync(join(tmpdir(), "profile-process-"));
  const moduleUrl = new URL(
   "../lib/session-profile-integration.ts",
   import.meta.url,
  ).href;
  const script = `
   import assert from "node:assert/strict";
   import { SessionManager } from "@earendil-works/pi-coding-agent";
   import { createSessionProfileIntegration } from ${JSON.stringify(moduleUrl)};
   ${incompatible ? 'globalThis[Symbol.for("gentle-pi.session-profile.lifecycle")] = { version: 2 };' : ""}
   const manager = SessionManager.inMemory(${JSON.stringify(root)});
   manager.appendCustomEntry("gentle-pi.session-profile/v1", { kind: "bind", origin: "user", name: "unwritten", modelProfiles: {} });
   const before = JSON.stringify(manager.getEntries()); let calls = 0;
   const live = createSessionProfileIntegration().start(manager, () => { calls++; }, { reason: "startup" });
   assert.equal(live.outcome.status, "indeterminate");
   ${incompatible ? 'assert.equal(live.attachment.bind("rejected", {}).status, "indeterminate");' : ""}
   assert.equal(JSON.stringify(manager.getEntries()), before);
   process.stdout.write(JSON.stringify({ status: live.outcome.status, calls, unchanged: true }));
  `;
  const result = spawnSync(
   process.execPath,
   ["--experimental-strip-types", "--input-type=module", "-e", script],
   { encoding: "utf8", cwd: process.cwd(), env: process.env },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(
   result.stdout,
   '{"status":"indeterminate","calls":0,"unchanged":true}',
  );
 });
}

for (const position of ["before", "at"] as const) {
 test(`fork boundary label supports ${position} without requiring its removed ID`, () => {
  const f = fixture();
  flush(f.manager);
  const live = f.integration.start(f.manager, f.append, { reason: "startup" });
  live.attachment.bind("retained", {});
  const retained = f.manager.getLeafId();
  assert.ok(retained);
  f.manager.appendLabelChange(retained, "boundary");
  const label = f.manager.getLeafId();
  assert.ok(label);
  let entryId = label;
  if (position === "before") {
   flush(f.manager);
   entryId = f.manager.getLeafId()!;
  }
  assert.equal(
   f.integration.beforeFork(f.manager, { entryId, position }).status,
   "captured",
  );
  const copy = persistedCopy(f.manager, label);
  assert.equal(copy.getEntry(label), undefined);
  f.integration.shutdown(f.manager, {
   reason: "fork",
   targetSessionFile: copy.getSessionFile(),
  });
  const current = createSessionProfileIntegration().start(
   copy,
   (t, d) => {
    copy.appendCustomEntry(t, d);
   },
   { reason: "fork", previousSessionFile: f.manager.getSessionFile() },
  );
  name(current.outcome, "retained");
 });
}
