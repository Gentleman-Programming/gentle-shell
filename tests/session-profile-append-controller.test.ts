import assert from "node:assert/strict";
import { test } from "node:test";
import {
 createSessionProfileAppendController,
 type SessionProfileAppendOutcome,
} from "../lib/session-profile-append-controller.ts";
import { normalizeModelConfig } from "../lib/model-routing-authority.ts";
import { SESSION_PROFILE_CUSTOM_TYPE as customType } from "../lib/session-profile-persistence.ts";

function fixture() {
 let id = "session",
  file: string | undefined = "session.jsonl",
  rows: any[] = [],
  text: string | undefined;
 let mode = "normal",
  serial = 0;
 const source = {
  getSessionId: () => id,
  getSessionFile: () => file,
  getBranch: () => rows,
 };
 const readFile = () => {
  if (text === undefined)
   throw Object.assign(new Error("missing"), { code: "ENOENT" });
  if (text === "unreadable")
   throw Object.assign(new Error("denied"), { code: "EACCES" });
  return text;
 };
 const save = () => {
  text = [
   JSON.stringify({ type: "session", id }),
   ...rows.map((row) => JSON.stringify(row)),
  ].join("\n");
 };
 const append = (type: string, data: unknown) => {
  if (mode === "throw-no-advance") throw new Error("append");
  rows.push({
   type: "custom",
   customType: type,
   data,
   id: `entry-${++serial}`,
   parentId: rows.at(-1)?.id ?? null,
   timestamp: "now",
  });
  if (mode === "throw") throw new Error("append");
  if (mode === "change") id = "other";
  if (mode === "disk" || mode === "throw-after-save") save();
  if (mode === "throw-after-save") throw new Error("append");
 };
 const controller = createSessionProfileAppendController(source, append, {
  readFile,
 });
 return {
  source,
  controller,
  save,
  append,
  readFile,
  get rows() {
   return rows;
  },
  set rows(value) {
   rows = value;
  },
  get text() {
   return text;
  },
  set text(value) {
   text = value;
  },
  set mode(value) {
   mode = value;
  },
  set id(value) {
   id = value;
  },
  set file(value) {
   file = value;
  },
 };
}
function bound(result: SessionProfileAppendOutcome, name: string) {
 const state = result.state;
 assert.equal(state.status, "bound");
 if (state.status !== "bound") throw new Error("Expected bound authority");
 assert.equal(state.binding.name, name);
 return state.binding;
}

for (const operation of ["bind", "clear"] as const) {
 test(`explicit preflush ${operation} is honest, refresh upgrades only after disk flush`, () => {
  const f = fixture();
  const result =
   operation === "bind"
    ? f.controller.bind("chosen", {})
    : f.controller.clear();
  assert.equal(result.status, "not-persisted");
  assert.equal(result.state.status, operation === "bind" ? "bound" : "cleared");
  assert.equal(f.controller.refresh().status, "not-persisted");
  f.save();
  assert.equal(f.controller.refresh().status, "persisted");
 });
 test(`failed ${operation} advances ghost but preserves corroborated disk selection`, () => {
  const f = fixture();
  f.mode = "disk";
  f.controller.bind("good", {});
  f.mode = "throw";
  const result =
   operation === "bind"
    ? f.controller.bind("failed", {})
    : f.controller.clear();
  assert.equal(result.status, "append-failed-preserved");
  bound(result, "good");
  f.save();
  bound(f.controller.refresh(), "good");
  f.rows.push({
   type: "custom",
   customType: "ordinary",
   data: {},
   id: "ordinary",
   parentId: f.rows.at(-1).id,
   timestamp: "now",
  });
  f.save();
  bound(f.controller.refresh(), "good");
  const rows = f.rows;
  f.rows = rows.slice(0, 1);
  f.controller.refresh();
  f.rows = rows;
  bound(f.controller.refresh(), "good");
  f.mode = "disk";
  const recovery =
   operation === "bind"
    ? f.controller.bind("recovered", {})
    : f.controller.clear();
  assert.equal(recovery.status, "persisted");
  assert.equal(
   recovery.state.status,
   operation === "bind" ? "bound" : "cleared",
  );
 });
}
test("restoration does not activate an unwritten public branch", () => {
 const f = fixture();
 f.append(customType, {
  kind: "bind",
  origin: "user",
  name: "unwritten",
  modelProfiles: {},
 });
 assert.equal(f.controller.refresh().status, "indeterminate");
});
test("real normalized routes, user schema and detached orchestrator are preserved", () => {
 const f = fixture();
 f.mode = "disk";
 const models = normalizeModelConfig({
  worker: "offline/model",
  reviewer: { effort: "high" },
  orchestrator: "offline/controller",
 })!;
 const result = f.controller.bind("normalized", models);
 assert.equal(result.status, "persisted");
 assert.deepEqual(f.rows.at(-1).data, {
  kind: "bind",
  origin: "user",
  name: "normalized",
  modelProfiles: {
   worker: { model: "offline/model" },
   reviewer: { thinking: "high" },
   orchestrator: { model: "offline/controller" },
  },
 });
 bound(result, "normalized").modelProfiles.worker.model = "mutated";
 assert.equal(
  bound(f.controller.refresh(), "normalized").modelProfiles.worker.model,
  "offline/model",
 );
});
for (const fault of [
 "missing",
 "corrupt",
 "unreadable",
 "mismatch",
 "wrong-session",
]) {
 test(`successful append cannot adopt against established ${fault} disk`, () => {
  const f = fixture();
  f.mode = "disk";
  f.controller.bind("old", {});
  f.mode = "normal";
  if (fault === "missing") f.text = undefined;
  if (fault === "corrupt") f.text = "{";
  if (fault === "unreadable") f.text = "unreadable";
  if (fault === "wrong-session")
   f.text = JSON.stringify({ type: "session", id: "wrong" });
  const result = f.controller.bind("new", {});
  assert.equal(result.status, "indeterminate");
  assert.equal(f.controller.refresh().status, "indeterminate");
 });
}
for (const fault of [
 "missing",
 "corrupt",
 "unreadable",
 "mismatch",
 "wrong-session",
]) {
 test(`uncorroborated append stays untrusted after ${fault} disk recovers`, () => {
  const f = fixture();
  f.mode = "disk";
  f.controller.bind("old", {});
  f.mode = "normal";
  if (fault === "missing") f.text = undefined;
  if (fault === "corrupt") f.text = "{";
  if (fault === "unreadable") f.text = "unreadable";
  if (fault === "wrong-session")
   f.text = JSON.stringify({ type: "session", id: "wrong" });
  assert.equal(f.controller.bind("new", {}).status, "indeterminate");
  f.save();
  const later = f.controller.refresh();
  assert.equal(later.status, "indeterminate", "a reported failure is never adopted later");
  assert.equal(later.state.status, "indeterminate");
  f.mode = "disk";
  bound(f.controller.bind("again", {}), "again");
 });
}
for (const status of ["bound", "cleared", "invalid", "unsupported"] as const) {
 test(`no-advance exception retains only corroborated ${status} authority`, () => {
  const f = fixture();
  f.mode = "disk";
  if (status === "bound") f.controller.bind("old", {});
  else
   f.append(
    status === "unsupported" ? "gentle-pi.session-profile/v2" : customType,
    status === "cleared" ? { kind: "clear" } : {},
   );
  f.mode = "throw-no-advance";
  const result = f.controller.bind("failed", {});
  assert.equal(result.status, "append-failed-preserved");
  assert.equal(result.state.status, status);
  f.text = "unreadable";
  assert.equal(f.controller.clear().status, "indeterminate");
 });
}
for (const previous of ["cleared", "invalid", "unsupported"] as const) {
 for (const failure of ["bind", "clear"] as const) {
  test(`advanced failed ${failure} preserves terminal prior ${previous}, even after ghost reaches disk`, () => {
   const f = fixture();
   f.mode = "disk";
   f.append(
    previous === "unsupported" ? "gentle-pi.session-profile/v2" : customType,
    previous === "cleared" ? { kind: "clear" } : {},
   );
   f.mode = "throw";
   const result =
    failure === "bind" ? f.controller.bind("ghost", {}) : f.controller.clear();
   assert.equal(result.status, "append-failed-preserved");
   assert.equal(result.state.status, previous);
   f.save();
   assert.equal(f.controller.refresh().state.status, previous);
   f.mode = "disk";
   assert.equal(f.controller.clear().status, "persisted");
   assert.equal(f.controller.refresh().state.status, "cleared");
  });
 }
}
test("no disk on no-advance failure cannot manufacture previous authority", () => {
 const f = fixture();
 f.mode = "throw-no-advance";
 assert.equal(f.controller.bind("failed", {}).status, "indeterminate");
 assert.equal(f.rows.length, 0);
 assert.equal(f.controller.refresh().status, "indeterminate");
});
test("throw after exact disk write is still never success and quarantines failed record", () => {
 const f = fixture();
 f.mode = "disk";
 f.controller.bind("good", {});
 f.mode = "throw-after-save";
 const result = f.controller.clear();
 assert.equal(result.status, "append-failed-preserved");
 bound(result, "good");
 bound(f.controller.refresh(), "good");
});
test("changed append scope fails closed without carrying authority across sessions", () => {
 const f = fixture();
 f.mode = "change";
 assert.equal(f.controller.bind("new", {}).status, "indeterminate");
 assert.equal(f.controller.refresh().status, "indeterminate");
});
test("pending selection revoked by branch switch cannot return from older memory", () => {
 const f = fixture();
 f.controller.bind("pending", {});
 const rows = f.rows;
 f.rows = [];
 assert.equal(f.controller.refresh().status, "indeterminate");
 f.rows = rows;
 assert.equal(f.controller.refresh().status, "indeterminate");
});
for (const terminal of [customType, "gentle-pi.session-profile/v2"]) {
 test(`new terminal ${terminal} never resurrects pending or disk older binding`, () => {
  const f = fixture();
  f.controller.bind("pending", {});
  f.append(terminal, {});
  f.save();
  assert.equal(
   f.controller.refresh().state.status,
   terminal === customType ? "invalid" : "unsupported",
  );
  f.rows = f.rows.slice(0, 1);
  f.text = undefined;
  assert.equal(f.controller.refresh().status, "indeterminate");
 });
}
test("quarantine survives repeated exceptions and does not cross session or file", () => {
 const f = fixture();
 f.mode = "disk";
 f.controller.clear();
 f.mode = "throw";
 f.controller.bind("failed-one", {});
 f.controller.bind("failed-two", {});
 f.save();
 assert.equal(f.controller.refresh().state.status, "cleared");
 f.id = "replacement";
 f.save();
 bound(f.controller.refresh(), "failed-two");
 f.id = "session";
 f.file = "replacement.jsonl";
 f.save();
 bound(f.controller.refresh(), "failed-two");
 f.file = "session.jsonl";
 assert.equal(f.controller.refresh().state.status, "cleared");
});
test("separate controller cannot restore another controller's volatile selection", () => {
 const f = fixture();
 f.controller.bind("pending", {});
 const other = createSessionProfileAppendController(f.source, f.append, {
  readFile: () => {
   throw Object.assign(new Error(), { code: "ENOENT" });
  },
 });
 assert.equal(other.refresh().status, "indeterminate");
});

test("pending scope is revoked across session/file switches without transferring volatile state", () => {
 const f = fixture();
 f.controller.bind("pending", {});
 f.id = "other";
 assert.equal(f.controller.refresh().status, "indeterminate");
 f.id = "session";
 assert.equal(f.controller.refresh().status, "indeterminate");
 f.controller.clear();
 f.file = undefined;
 assert.equal(f.controller.refresh().status, "indeterminate");
 f.file = "session.jsonl";
 assert.equal(f.controller.refresh().status, "indeterminate");
});
test("undefined file permits only a freshly explicit setup-only selection", () => {
 const f = fixture();
 f.file = undefined;
 assert.equal(f.controller.clear().status, "not-persisted");
 assert.equal(f.controller.refresh().status, "not-persisted");
});
test("missing-file evidence permits only a NEW explicit selection, not unwritten restoration or first-flush proof", () => {
 const f = fixture();
 f.append(customType, { kind: "clear" });
 assert.equal(f.controller.refresh().status, "indeterminate");
 const result = f.controller.bind("new", {});
 assert.equal(result.status, "not-persisted");
 bound(result, "new");
 assert.equal(f.controller.refresh().status, "not-persisted");
});
test("conversation with missing disk cannot be relabelled as preflush", () => {
 const f = fixture();
 f.rows.push({
  type: "message",
  id: "message",
  parentId: null,
  timestamp: "now",
  message: { role: "user" },
 });
 assert.equal(f.controller.clear().status, "indeterminate");
});
for (const mutation of ["file", "branch", "payload", "no-append"] as const) {
 test(`successful ${mutation} mutation fails closed and cannot activate by refresh`, () => {
  const f = fixture();
  f.mode = "disk";
  f.controller.bind("good", {});
  const candidate = createSessionProfileAppendController(
   f.source,
   (type, data) => {
    if (mutation === "no-append") return;
    f.append(type, mutation === "payload" ? { kind: "clear" } : data);
    if (mutation === "file") f.file = "changed.jsonl";
    if (mutation === "branch") {
     f.rows = f.rows.slice(-1);
     f.save();
    }
   },
   { readFile: () => f.text! },
  );
  assert.equal(candidate.bind("requested", {}).status, "indeterminate");
  assert.equal(candidate.refresh().status, "indeterminate");
 });
}
test("exact selected disk content mismatch and changed source during read are indeterminate", () => {
 const f = fixture();
 f.mode = "disk";
 f.controller.bind("good", {});
 const mismatch = createSessionProfileAppendController(
  f.source,
  (type, data) => {
   f.append(type, data);
   const lines = f.text!.split("\n");
   const row = JSON.parse(lines.at(-1)!);
   row.data.name = "mismatched";
   lines[lines.length - 1] = JSON.stringify(row);
   f.text = lines.join("\n");
  },
  { readFile: () => f.text! },
 );
 assert.equal(mismatch.bind("requested", {}).status, "indeterminate");
 const changing = createSessionProfileAppendController(f.source, f.append, {
  readFile: () => {
   f.id = "changed";
   return f.text!;
  },
 });
 assert.equal(changing.refresh().status, "indeterminate");
});
test("no-advance failed clear preserves a prior tombstone and never reports success", () => {
 const f = fixture();
 f.mode = "disk";
 f.controller.clear();
 f.mode = "throw-no-advance";
 const failed = f.controller.clear();
 assert.equal(failed.status, "append-failed-preserved");
 assert.equal(failed.state.status, "cleared");
});
test("JSON omission and toJSON semantics match observable disk without leaking references", () => {
 const f = fixture();
 f.mode = "disk";
 f.controller.bind("json", {});
 const row = f.rows[0];
 row.extra = undefined;
 row.toJSON = function () {
  return { ...this, extra: undefined };
 };
 f.save();
 bound(f.controller.refresh(), "json");
});
for (const failure of ["cycle", "bigint", "getter", "toJSON"] as const) {
 test(`unserializable ${failure} source cannot manufacture authority`, () => {
  const f = fixture();
  f.mode = "disk";
  f.controller.bind("good", {});
  const row = f.rows[0];
  if (failure === "cycle") row.extra = row;
  if (failure === "bigint") row.extra = 1n;
  if (failure === "getter")
   Object.defineProperty(row, "extra", {
    enumerable: true,
    get() {
     throw new Error("private detail");
    },
   });
  if (failure === "toJSON")
   row.toJSON = () => {
    throw new Error("private detail");
   };
  assert.equal(f.controller.refresh().status, "indeterminate");
  assert.equal(f.controller.clear().status, "indeterminate");
 });
}
test("failed snapshot still quarantines observable IDs, explicit recovery cannot resurrect ghost", () => {
 const f = fixture();
 f.mode = "disk";
 f.controller.bind("good", {});
 let fail = false;
 const candidate = createSessionProfileAppendController(
  f.source,
  (type, data) => {
   f.append(type, data);
   if (fail) {
    f.rows.at(-1).extra = 1n;
    throw new Error("append");
   }
  },
  { readFile: () => f.text! },
 );
 assert.equal(candidate.bind("trusted", {}).status, "persisted");
 fail = true;
 assert.equal(candidate.bind("ghost", {}).status, "indeterminate");
 delete f.rows.at(-1).extra;
 f.save();
 assert.equal(candidate.refresh().status, "indeterminate");
 const ghostBranch = f.rows.slice();
 fail = false;
 assert.equal(candidate.clear().status, "persisted");
 f.rows = ghostBranch;
 assert.equal(candidate.refresh().status, "indeterminate");
});
// Injected structural-source fault, NOT ordinary Pi ID reuse or EISDIR.
for (const changed of ["data", "timestamp", "parentId", "extra"] as const) {
 test(`whole-record certificate rejects same-ID ${changed} mutation after throw, recovery and branch return`, () => {
  const f = fixture();
  f.mode = "disk";
  let fail = false;
  const candidate = createSessionProfileAppendController(
   f.source,
   (type, data) => {
    if (!fail) return f.append(type, data);
    const row = f.rows[0];
    if (changed === "data") row.data.name = "FAILED";
    if (changed === "timestamp") row.timestamp = "changed";
    if (changed === "parentId") row.parentId = "injected-missing-parent";
    if (changed === "extra") row.extra = { injected: "FAILED" };
    f.save();
    throw new Error("injected mutation during failed append");
   },
   { readFile: () => f.text! },
  );
  assert.equal(candidate.bind("trusted", {}).status, "persisted");
  const trusted = JSON.parse(JSON.stringify(f.rows));
  fail = true;
  assert.equal(candidate.bind("failed", {}).status, "indeterminate");
  const changedBranch = f.rows.slice();
  fail = false;
  assert.equal(candidate.clear().status, "persisted");
  assert.equal(candidate.refresh().state.status, "cleared");
  f.rows = changedBranch;
  assert.equal(candidate.refresh().status, "indeterminate");
  // Restoring the exact certified fixture content is not history repair.
  f.rows = trusted;
  f.save();
  bound(candidate.refresh(), "trusted");
 });
}
test("unobservable newer branch revokes pending selection permanently", () => {
 const f = fixture();
 assert.equal(f.controller.bind("pending", {}).status, "not-persisted");
 const original = f.rows.slice();
 f.append(customType, {});
 f.rows.at(-1).extra = 1n;
 assert.equal(f.controller.refresh().status, "indeterminate");
 f.rows = original;
 assert.equal(f.controller.refresh().status, "indeterminate");
});
test("invalid encoder input fails before append without corrupting existing authority", () => {
 const f = fixture();
 f.mode = "disk";
 f.controller.bind("good", {});
 const length = f.rows.length;
 assert.throws(() => f.controller.bind("", {}), TypeError);
 assert.equal(f.rows.length, length);
 bound(f.controller.refresh(), "good");
});

// A stability recheck that throws after a successful append takes the catch
// path; the record must stay untrusted even though the disk is sound. The
// fourth branch read after the append is that recheck.
test("a throwing post-append stability recheck is never adopted later", () => {
  const failingRead = 4;
  let rows: any[] = [],
   text: string | undefined,
   serial = 0,
   armed = false,
   reads = 0;
  const save = () => {
   text = [
    JSON.stringify({ type: "session", id: "session" }),
    ...rows.map((row) => JSON.stringify(row)),
   ].join("\n");
  };
  const source = {
   getSessionId: () => "session",
   getSessionFile: () => "session.jsonl",
   getBranch: () => {
    if (armed && ++reads === failingRead) throw new Error("branch");
    return rows;
   },
  };
  const controller = createSessionProfileAppendController(
   source,
   (type, data) => {
    rows.push({
     type: "custom",
     customType: type,
     data,
     id: `entry-${++serial}`,
     parentId: rows.at(-1)?.id ?? null,
     timestamp: "now",
    });
    save();
    armed = true;
   },
   {
    readFile: () => {
     if (text === undefined)
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
     return text;
    },
   },
  );
  const result = controller.bind("new", {});
  armed = false;
  assert.equal(result.status, "indeterminate");
  assert.equal(
   (result.state as { reason?: string }).reason,
   "append-not-corroborated",
  );
  const later = controller.refresh();
  assert.equal(later.status, "indeterminate", "a reported failure is never adopted later");
  armed = false;
  bound(controller.bind("again", {}), "again");
});
