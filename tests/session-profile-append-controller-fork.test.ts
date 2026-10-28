// Fork lifecycle seams against public Pi SessionManager fixtures in temp dirs.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
 createSessionProfileAppendController,
 type SessionProfileAppendOptions,
 type SessionProfileAppendOutcome,
 type SessionProfileForkTarget,
} from "../lib/session-profile-append-controller.ts";

type Controller = ReturnType<typeof createSessionProfileAppendController>;

function fixture(memory = false) {
 const root = mkdtempSync(join(tmpdir(), "profile-fork-"));
 const manager = memory
  ? SessionManager.inMemory(root)
  : SessionManager.create(root, join(root, "sessions"));
 let fail = false,
  calls = 0;
 const controller = createSessionProfileAppendController(
  manager,
  (type, data) => {
   calls++;
   manager.appendCustomEntry(type, data);
   if (fail) throw new Error("injected callback failure after public append");
  },
 );
 return {
  manager,
  controller,
  failing(value: boolean) {
   fail = value;
  },
  calls: () => calls,
 };
}
function flush(manager: SessionManager) {
 manager.appendMessage({
  role: "user",
  content: "isolated fork fixture",
  timestamp: 1,
 });
}
function name(outcome: SessionProfileAppendOutcome, expected: string) {
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
// Mirrors the host order: capture, copy, detach with the preparation, then
// attach the destination with the handoff and its own public view. An
// in-memory fork rewrites the same manager, so it copies after detach.
function fork(
 parent: Controller,
 manager: SessionManager,
 target: SessionProfileForkTarget,
 copy: (prepared: boolean) => SessionManager,
 options: SessionProfileAppendOptions = {},
) {
 const captured = parent.captureForkEvidence(target, manager);
 const previousSessionFile = manager.getSessionFile();
 const inPlace = manager.getSessionFile() === undefined;
 let child = inPlace ? manager : copy(captured.status === "captured");
 const handoff = parent.detach({
  reason: "fork",
  targetSessionFile: inPlace ? undefined : child.getSessionFile(),
  preparation:
   captured.status === "captured" ? captured.evidence : undefined,
 });
 if (inPlace) child = copy(captured.status === "captured");
 let appends = 0;
 const append = (type: string, data: unknown) => {
  appends++;
  child.appendCustomEntry(type, data);
 };
 // The host keeps one controller per manager; an in-memory fork reuses it.
 const controller =
  child === manager
   ? parent
   : createSessionProfileAppendController(child, append);
 const attachment = controller.attach(
  child,
  append,
  {
   reason: "fork",
   previousSessionFile,
   ...(handoff ? { fork: { handoff, publicView: child } } : {}),
  },
  options,
 );
 return {
  captured,
  handoff,
  child,
  controller,
  attachment,
  outcome: attachment.refresh(),
  appends: () => appends,
  reattach: () =>
   createSessionProfileAppendController(child, append).attach(child, append, {
    reason: "fork",
    previousSessionFile,
    ...(handoff ? { fork: { handoff, publicView: child } } : {}),
   }),
 };
}

test("disk-first fork retains copied failure quarantine but does not inherit binding", () => {
 const f = fixture();
 f.failing(true);
 assert.equal(f.controller.bind("failed", {}).status, "indeterminate");
 f.failing(false);
 const failed = f.manager.getLeafId();
 assert.ok(failed);
 assert.equal(existsSync(f.manager.getSessionFile()!), false);
 // Genuine public first flush now writes the known-failed record as well.
 flush(f.manager);
 const forked = fork(
  f.controller,
  f.manager,
  { entryId: failed, position: "at" },
  () => persistedCopy(f.manager, failed),
 );
 assert.equal(forked.captured.status, "captured");
 assert.ok(forked.handoff);
 // No conversation on the copied path: the child file need not exist yet.
 assert.equal(forked.outcome.status, "indeterminate");
 assert.equal(existsSync(forked.child.getSessionFile()!), false);
 flush(forked.child);
 assert.equal(forked.attachment.refresh().state.status, "absent");
 assert.equal(forked.attachment.clear().status, "persisted");
 // A consumed handoff cannot be replayed into a second attachment.
 assert.equal(forked.reattach().refresh().status, "indeterminate");
});

test("actual copied cut beyond the prepared ancestor fails closed", () => {
 const f = fixture();
 flush(f.manager);
 assert.equal(f.controller.bind("trusted", {}).status, "persisted");
 const preparedCut = f.manager.getLeafId();
 assert.ok(preparedCut);
 f.failing(true);
 const failed = f.controller.bind("known-failed", {});
 f.failing(false);
 assert.equal(failed.status, "append-failed-preserved");
 name(failed, "trusted");
 const actualCut = f.manager.getLeafId();
 assert.ok(actualCut);
 assert.notEqual(actualCut, preparedCut);
 const sourceFile = f.manager.getSessionFile()!;
 const sourceEntries = JSON.stringify(f.manager.getEntries());
 const sourceDisk = readFileSync(sourceFile, "utf8");
 let childEntries = "",
  childDisk = "";
 const forked = fork(
  f.controller,
  f.manager,
  { entryId: preparedCut, position: "at" },
  () => {
   const child = persistedCopy(f.manager, actualCut);
   assert.ok(child.getBranch().some((entry) => entry.id === preparedCut));
   childEntries = JSON.stringify(child.getEntries());
   childDisk = readFileSync(child.getSessionFile()!, "utf8");
   assert.ok(childDisk.includes(actualCut), "public copy stores the failure");
   return child;
  },
 );
 assert.deepEqual(forked.outcome, {
  status: "indeterminate",
  state: { status: "indeterminate", reason: "ambiguous-append" },
 });
 assert.deepEqual(forked.attachment.refresh(), forked.outcome);
 assert.equal(forked.appends(), 0);
 assert.equal(f.calls(), 2);
 assert.equal(JSON.stringify(forked.child.getEntries()), childEntries);
 assert.equal(readFileSync(forked.child.getSessionFile()!, "utf8"), childDisk);
 assert.equal(JSON.stringify(f.manager.getEntries()), sourceEntries);
 assert.equal(readFileSync(sourceFile, "utf8"), sourceDisk);
});

for (const position of ["before", "at"] as const) {
 test(`cancelled ${position} capture leaves entries, activation and callbacks unchanged`, () => {
  const f = fixture();
  assert.equal(f.controller.bind("pending", {}).status, "not-persisted");
  const leaf = f.manager.getLeafId();
  assert.ok(leaf);
  const before = JSON.stringify(f.manager.getEntries());
  const captured = f.controller.captureForkEvidence(
   { entryId: position === "at" ? leaf : "missing", position },
   f.manager,
  );
  assert.equal(
   captured.status,
   position === "at" ? "captured" : "indeterminate",
  );
  assert.equal(JSON.stringify(f.manager.getEntries()), before);
  assert.equal(f.controller.refresh().status, "not-persisted");
  assert.equal(f.controller.bind("next", {}).status, "not-persisted");
  assert.equal(f.calls(), 2);
 });
}

test("valid cancelled before-user capture leaves disk and explicit binding unchanged", () => {
 const f = fixture();
 flush(f.manager);
 const user = f.manager.getLeafId();
 assert.ok(user);
 f.controller.bind("current", {});
 const entries = JSON.stringify(f.manager.getEntries());
 const disk = readFileSync(f.manager.getSessionFile()!, "utf8");
 assert.equal(
  f.controller.captureForkEvidence(
   { entryId: user, position: "before" },
   f.manager,
  ).status,
  "captured",
 );
 assert.equal(JSON.stringify(f.manager.getEntries()), entries);
 assert.equal(readFileSync(f.manager.getSessionFile()!, "utf8"), disk);
 name(f.controller.refresh(), "current");
 assert.equal(f.calls(), 1);
});

test("capture rejects a public view other than the attached source", () => {
 const f = fixture();
 flush(f.manager);
 const other = fixture();
 assert.deepEqual(
  f.controller.captureForkEvidence(
   { entryId: f.manager.getLeafId()!, position: "at" },
   other.manager,
  ),
  { status: "indeterminate", reason: "unobservable-fork" },
 );
});

test("label removal permits only the expected copied parentId rechain", () => {
 const f = fixture();
 f.controller.bind("base", {});
 flush(f.manager);
 const base = f.manager.getLeafId();
 assert.ok(base);
 f.manager.appendLabelChange(base, "fixture-label");
 f.controller.bind("selected", {});
 const leaf = f.manager.getLeafId();
 assert.ok(leaf);
 const original = f.manager.getEntry(leaf)!;
 const forked = fork(
  f.controller,
  f.manager,
  { entryId: leaf, position: "at" },
  () => persistedCopy(f.manager, leaf),
 );
 assert.notEqual(forked.child.getEntry(leaf)?.parentId, original.parentId);
 name(forked.outcome, "selected");
});

for (const position of ["before", "at"] as const) {
 test(`fork boundary label supports ${position} without requiring its removed ID`, () => {
  const f = fixture();
  flush(f.manager);
  f.controller.bind("retained", {});
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
  const forked = fork(f.controller, f.manager, { entryId, position }, () => {
   const copy = persistedCopy(f.manager, label);
   assert.equal(copy.getEntry(label), undefined);
   return copy;
  });
  assert.equal(forked.captured.status, "captured");
  name(forked.outcome, "retained");
 });
}

test("actual fork path excludes failed sibling and never imports its quarantine", () => {
 const f = fixture();
 f.controller.bind("base", {});
 flush(f.manager);
 const base = f.manager.getLeafId();
 assert.ok(base);
 f.failing(true);
 f.controller.bind("failed-left", {});
 f.failing(false);
 const failed = f.manager.getLeafId();
 f.manager.branch(base);
 f.controller.bind("right", {});
 const right = f.manager.getLeafId();
 assert.ok(right);
 assert.notEqual(right, failed);
 const forked = fork(
  f.controller,
  f.manager,
  { entryId: right, position: "at" },
  () => persistedCopy(f.manager, right),
 );
 assert.equal(
  forked.child.getBranch().some((entry) => entry.id === failed),
  false,
 );
 name(forked.outcome, "right");
});

for (const changed of ["data", "timestamp", "parentId", "extra"] as const) {
 test(`copied same-ID ${changed} mutation fails closed without blessing destination disk`, () => {
  const f = fixture();
  flush(f.manager);
  f.controller.bind("trusted", {});
  const leaf = f.manager.getLeafId();
  assert.ok(leaf);
  let copy: SessionManager | undefined;
  const forked = fork(
   f.controller,
   f.manager,
   { entryId: leaf, position: "at" },
   () => {
    copy = persistedCopy(f.manager, leaf);
    const row = copy.getEntry(leaf)! as unknown as Record<string, any>;
    if (changed === "data") row.data.name = "FAILED";
    if (changed === "timestamp") row.timestamp = "changed";
    if (changed === "parentId") row.parentId = "unexpected-parent";
    if (changed === "extra") row.extra = { changed: true };
    return copy;
   },
   {
    // Inject matching disk content, not ordinary Pi ID reuse.
    readFile: (path) =>
     copy && path === copy.getSessionFile()
      ? [copy.getHeader(), ...copy.getEntries()]
         .map((entry) => JSON.stringify(entry))
         .join("\n")
      : readFileSync(path, "utf8"),
   },
  );
  assert.equal(forked.outcome.status, "indeterminate");
  assert.equal(forked.attachment.clear().status, "persisted");
  forked.child.branch(leaf);
  assert.equal(forked.attachment.refresh().status, "indeterminate");
 });
}

test("in-memory fork keeps same-manager evidence but never restores pending state", () => {
 const f = fixture(true);
 assert.equal(f.controller.bind("pending", {}).status, "not-persisted");
 const leaf = f.manager.getLeafId();
 assert.ok(leaf);
 const forked = fork(
  f.controller,
  f.manager,
  { entryId: leaf, position: "at" },
  () => {
   f.manager.createBranchedSession(leaf);
   return f.manager;
  },
 );
 assert.equal(forked.captured.status, "captured");
 assert.equal(forked.outcome.status, "indeterminate");
 assert.equal(
  forked.attachment.bind("new-explicit", {}).status,
  "not-persisted",
 );
 // The parent attachment was revoked by detach and cannot append.
 assert.equal(f.controller.clear().status, "indeterminate");
});

test("fork before root creates empty child without parent binding", () => {
 const f = fixture();
 flush(f.manager);
 const firstUser = f.manager.getLeafId();
 assert.ok(firstUser);
 f.controller.bind("parent", {});
 const previousSessionFile = f.manager.getSessionFile();
 const forked = fork(
  f.controller,
  f.manager,
  { entryId: firstUser, position: "before" },
  () => {
   const child = SessionManager.create(
    f.manager.getCwd(),
    f.manager.getSessionDir(),
   );
   child.newSession({ parentSession: previousSessionFile });
   return child;
  },
 );
 assert.equal(forked.captured.status, "captured");
 assert.equal(forked.outcome.status, "indeterminate");
 assert.equal(forked.attachment.bind("child", {}).status, "not-persisted");
});

test("detach rejects a preparation captured by another controller", () => {
 const f = fixture();
 flush(f.manager);
 const leaf = f.manager.getLeafId();
 assert.ok(leaf);
 const other = createSessionProfileAppendController(f.manager, () => {});
 const captured = other.captureForkEvidence(
  { entryId: leaf, position: "at" },
  f.manager,
 );
 assert.equal(captured.status, "captured");
 assert.equal(
  f.controller.detach({
   reason: "fork",
   targetSessionFile: join(f.manager.getSessionDir(), "child.jsonl"),
   preparation: captured.status === "captured" ? captured.evidence : undefined,
  }),
  undefined,
 );
 // Even a rejected proof still revokes the old capability.
 assert.equal(f.controller.refresh().status, "indeterminate");
});

test("empty destination cannot claim a prepared non-empty copied path", () => {
 const f = fixture();
 flush(f.manager);
 f.controller.bind("parent", {});
 const leaf = f.manager.getLeafId();
 assert.ok(leaf);
 const previousSessionFile = f.manager.getSessionFile();
 const forked = fork(
  f.controller,
  f.manager,
  { entryId: leaf, position: "at" },
  () => {
   const child = SessionManager.create(
    f.manager.getCwd(),
    f.manager.getSessionDir(),
   );
   child.newSession({ parentSession: previousSessionFile });
   return child;
  },
 );
 assert.equal(forked.captured.status, "captured");
 assert.equal(forked.outcome.status, "indeterminate");
 // A rejected destination cut cannot activate even a fresh explicit setup.
 assert.deepEqual(forked.attachment.bind("child", {}), {
  status: "indeterminate",
  state: { status: "indeterminate", reason: "append-not-corroborated" },
 });
});
