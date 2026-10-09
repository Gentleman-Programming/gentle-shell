// Observable append authority and explicit lifecycle seams; no SDK or consumers.
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
 hasSessionProfileCandidateMetadata,
 readSessionProfileDisk,
 type DiskProfileResult,
 type SessionProfileSource,
} from "./session-profile-disk-reader.ts";
import {
 createSessionProfileBind,
 createSessionProfileClear,
 isSessionProfileFamilyEntry,
 readSessionProfileEntry,
 SESSION_PROFILE_CUSTOM_TYPE,
 type SessionProfileBindPayload,
 type SessionProfileClearPayload,
} from "./session-profile-persistence.ts";

type Entry = {
 id: string;
 type: string;
 customType?: string;
 data?: unknown;
 [key: string]: unknown;
};
type Capture = { session: string; file: string | undefined; branch: Entry[] };
type Scope = {
 failed: Set<string>;
 established: boolean;
 ambiguous: boolean;
 // Ambiguity may clear after exact recovery, but historical unknown or changed
 // whole records remain untrusted on branch return. Source/session/file scope
 // belongs to this controller and its enclosing scopes map.
 uncertain: boolean;
 certified: Map<string, Entry>;
 // Copied uncertainty is not evidence of a failed append and is never excluded
 // through the reader's known-failed-ID seam.
 untrusted: Set<string>;
 pending?: Entry;
};
export type SessionProfileAppendOutcome = {
 status:
  | "persisted"
  | "not-persisted"
  | "append-failed-preserved"
  | "indeterminate";
 state: DiskProfileResult;
};
export interface SessionProfileAppendOptions {
 readFile?: (path: string) => string;
}
export interface SessionProfileForkView extends SessionProfileSource {
 getBranch(fromId?: string): readonly unknown[];
 getEntry(id: string): unknown;
 getHeader(): unknown;
}
export type SessionProfileForkTarget = {
 entryId: string;
 position: "before" | "at";
};
declare const forkProof: unique symbol;
export type SessionProfileForkPreparation = {
 readonly [forkProof]: "preparation";
};
export type SessionProfileForkHandoff = { readonly [forkProof]: "handoff" };
export type SessionProfileForkEvidence =
 | { status: "captured"; evidence: SessionProfileForkPreparation }
 | { status: "indeterminate"; reason: string };
export interface SessionProfileAttachment {
 bind(
  name: string,
  models: SessionProfileBindPayload["modelProfiles"],
 ): SessionProfileAppendOutcome;
 clear(): SessionProfileAppendOutcome;
 refresh(): SessionProfileAppendOutcome;
}
export type SessionProfileAttachContext = {
 reason: "startup" | "reload" | "new" | "resume" | "fork";
 previousSessionFile?: string;
 fork?: {
  handoff: SessionProfileForkHandoff;
  publicView: SessionProfileForkView;
 };
};
export type SessionProfileDetachContext = {
 reason: "reload" | "new" | "resume" | "fork" | "quit";
 targetSessionFile?: string;
 preparation?: SessionProfileForkPreparation;
};
type ForkSnapshot = {
 owner: object;
 generation: number;
 source: SessionProfileSource;
 scope: Capture;
 path: Entry[];
 leaf: string | null;
 failed: Set<string>;
 untrusted: Set<string>;
 ambiguous: boolean;
};
type ForkTransfer = ForkSnapshot & { targetFile?: string; consumed: boolean };
type ForkStore = {
 version: 1;
 preparations: WeakMap<object, ForkSnapshot>;
 transfers: WeakMap<object, ForkTransfer>;
};
// Keep the key stable across code reloads; the value owns protocol negotiation.
const forkStoreKey = Symbol.for("gentle-pi.session-profile.fork-evidence");
function forkStore(): ForkStore {
 const existing = Reflect.get(globalThis, forkStoreKey) as
  | ForkStore
  | undefined;
 if (existing) {
  if (
   existing.version !== 1 ||
   !(existing.preparations instanceof WeakMap) ||
   !(existing.transfers instanceof WeakMap)
  )
   throw new Error("fork-protocol");
  return existing;
 }
 const store: ForkStore = {
  version: 1,
  preparations: new WeakMap(),
  transfers: new WeakMap(),
 };
 Object.defineProperty(globalThis, forkStoreKey, { value: store });
 return store;
}
function detached<T>(value: T): T {
 try {
  return JSON.parse(JSON.stringify(value));
 } catch {
  // Callers fail closed without exposing getter, toJSON or serialization errors.
  throw new TypeError("Unserializable controller snapshot");
 }
}
function unavailable(reason: string): SessionProfileAppendOutcome {
 return { status: "indeterminate", state: { status: "indeterminate", reason } };
}
function sameScope(a: Capture, b: Capture): boolean {
 return a.session === b.session && a.file === b.file;
}
function prefix(a: Entry[], b: Entry[]): boolean {
 return b.length >= a.length && isDeepStrictEqual(a, b.slice(0, a.length));
}
function noConversation(branch: Entry[]): boolean {
 return !branch.some((entry) => entry.type === "message");
}

/**
 * appendEntry is the synchronous public extension seam (void, not an ID).
 * Only an explicit operation can activate preflush memory. Refresh never
 * restores unwritten getBranch selections. Quarantine survives branch changes
 * for each source/session/file. Only confirmed opaque fork evidence can convey
 * copied-path quarantine; attachment handles never transfer activation.
 * Corroboration does not promise fsync, full ancestry or external-writer safety.
 */
export function createSessionProfileAppendController(
 initialSource: SessionProfileSource,
 initialAppendEntry: (customType: string, data: unknown) => void,
 options: SessionProfileAppendOptions = {},
) {
 // Evidence survives detach, but source identity still partitions all scopes.
 const sourceScopes = new WeakMap<
  SessionProfileSource,
  Map<string, Map<string | undefined, Scope>>
 >();
 let scopes = new Map<string, Map<string | undefined, Scope>>();
 sourceScopes.set(initialSource, scopes);
 let source: SessionProfileSource | undefined = initialSource;
 let appendEntry: ((customType: string, data: unknown) => void) | undefined =
  initialAppendEntry;
 let generation = 0;
 const identity = {};
 let active: Scope | undefined;
 let readFile: ((file: string) => string) | undefined =
  options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
 function capture(): Capture {
  if (!source) throw new Error("detached-source");
  const session = source.getSessionId(),
   file = source.getSessionFile();
  if (!session || (file !== undefined && (typeof file !== "string" || !file)))
   throw new Error("source");
  const raw = source.getBranch();
  if (!Array.isArray(raw)) throw new Error("branch");
  // Match the reader's own-field requirements before JSON can hide inherited
  // metadata or an entry's toJSON can manufacture otherwise missing fields.
  for (const value of raw) {
   if (
    isSessionProfileFamilyEntry(value) &&
    !hasSessionProfileCandidateMetadata(value)
   )
    throw new Error("profile-metadata");
  }
  const branch = detached(raw) as Entry[];
  if (
   branch.some(
    (entry) =>
     !entry ||
     typeof entry !== "object" ||
     typeof entry.id !== "string" ||
     !entry.id,
   )
  )
   throw new Error("metadata");
  if (new Set(branch.map((entry) => entry.id)).size !== branch.length)
   throw new Error("duplicate");
  return { session, file, branch };
 }
 function scope(c: Capture): Scope {
  let files = scopes.get(c.session);
  if (!files) {
   files = new Map();
   scopes.set(c.session, files);
  }
  let state = files.get(c.file);
  if (!state) {
   state = {
    failed: new Set(),
    established: false,
    ambiguous: false,
    uncertain: false,
    certified: new Map(),
    untrusted: new Set(),
   };
   files.set(c.file, state);
  }
  if (active !== state) {
   if (active) active.pending = undefined;
   active = state;
  }
  return state;
 }
 function stable(c: Capture): boolean {
  const now = capture();
  return sameScope(c, now) && isDeepStrictEqual(c.branch, now.branch);
 }
 function authority(c: Capture, s: Scope) {
  let missing = c.file === undefined;
  const state = readSessionProfileDisk(source, {
   knownFailedEntryIds: s.failed,
   readFile(file) {
    try {
     if (!readFile) throw new Error("detached-reader");
     const text = readFile(file);
     s.established = true;
     return text;
    } catch (error) {
     missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
     if (!missing) s.established = true;
     throw error;
    }
   },
  });
  // Accepted observable evidence, not proof of first flush. Only append's exact
  // NEW record or this controller's still-exact pending selection can activate.
  // A fresh refresh never restores older unwritten branch entries.
  return {
   state,
   preflush:
    missing &&
    !s.established &&
    !s.ambiguous &&
    s.failed.size === 0 &&
    noConversation(c.branch) &&
    stable(c),
  };
 }
 function selected(c: Capture, s: Scope): Entry | undefined {
  return c.branch.findLast((entry) => isSessionProfileFamilyEntry(entry) && !s.failed.has(entry.id));
 }
 function uncertainSelection(c: Capture, s: Scope): boolean {
  // Under unknown branch movement, even the raw newest family entry must be
  // a separately corroborated recovery. Exclusion cannot revive an older
  // certified selection when the newest entry's provenance is ambiguous.
  const latest = c.branch.findLast(isSessionProfileFamilyEntry);
  return (
   (latest !== undefined && s.untrusted.has(latest.id)) ||
   (s.uncertain &&
    (!latest || !isDeepStrictEqual(s.certified.get(latest.id), latest)))
  );
 }
 function refresh(): SessionProfileAppendOutcome {
  try {
   const c = capture(),
    s = scope(c),
    latest = selected(c, s);
   if (s.pending && !isDeepStrictEqual(s.pending, latest))
    s.pending = undefined;
   const observed = authority(c, s);
   if (!stable(c)) {
    s.pending = undefined;
    return unavailable("source-changed");
   }
   if (observed.state.status !== "indeterminate") {
    s.pending = undefined;
    if (s.ambiguous || uncertainSelection(c, s))
     return unavailable("ambiguous-append");
    return detached({ status: "persisted", state: observed.state });
   }
   if (observed.preflush && s.pending)
    return detached({
     status: "not-persisted",
     state: readSessionProfileEntry(s.pending),
    });
   s.pending = undefined;
   return { status: "indeterminate", state: observed.state };
  } catch {
   if (active) active.pending = undefined;
   return unavailable("unobservable-source");
  }
 }
 function append(
  payload: SessionProfileBindPayload | SessionProfileClearPayload,
 ): SessionProfileAppendOutcome {
  let before: Capture;
  try {
   before = capture();
  } catch {
   if (active) active.pending = undefined;
   return unavailable("unobservable-source");
  }
  const s = scope(before);
  s.pending = undefined;
  let preflush: boolean;
  try {
   preflush = authority(before, s).preflush;
   if (!stable(before)) return unavailable("source-changed");
  } catch {
   return unavailable("unobservable-source");
  }
  let threw = false;
  try {
   if (!appendEntry) return unavailable("detached-source");
   appendEntry(SESSION_PROFILE_CUSTOM_TYPE, detached(payload));
  } catch {
   threw = true;
  }
  let after: Capture;
  try {
   after = capture();
  } catch {
   s.ambiguous = true;
   s.uncertain = true;
   // Snapshot failure may still leave observable public ID evidence. Never
   // invent an ID or move quarantine into an unconfirmed session/file.
   if (threw) {
    try {
     if (
      source.getSessionId() === before.session &&
      source.getSessionFile() === before.file
     ) {
      const old = new Set(before.branch.map((entry) => entry.id));
      for (const value of source.getBranch()) {
       if (value && typeof value === "object") {
        const entry = value as Entry;
        if (
         isSessionProfileFamilyEntry(entry) &&
         typeof entry.id === "string" &&
         entry.id &&
         !old.has(entry.id)
        )
         s.failed.add(entry.id);
       }
      }
     }
    } catch {
     /* No manufactured evidence when public access itself fails. */
    }
   }
   return unavailable("unobservable-append");
  }
  if (!sameScope(before, after)) {
   s.ambiguous = true;
   s.uncertain = true;
   const changed = scope(after);
   changed.ambiguous = true;
   changed.uncertain = true;
   changed.pending = undefined;
   return unavailable("append-scope-changed");
  }
  const oldIds = new Set(before.branch.map((entry) => entry.id));
  const added = after.branch.filter((entry) => !oldIds.has(entry.id));
  if (threw) {
   for (const entry of added) if (isSessionProfileFamilyEntry(entry)) s.failed.add(entry.id);
   if (!prefix(before.branch, after.branch)) {
    s.ambiguous = true;
    s.uncertain = true;
   }
   try {
    const observed = authority(after, s).state;
    if (
     !stable(after) ||
     s.ambiguous ||
     uncertainSelection(after, s) ||
     observed.status === "indeterminate"
    )
     return unavailable("append-failed-authority-unavailable");
    return detached({ status: "append-failed-preserved", state: observed });
   } catch {
    return unavailable("append-failed-authority-unavailable");
   }
  }
  // Public branch evidence, never the callback's return value, identifies the
  // one new selected profile record. Neither old nor mismatched records count.
  const entry = added[0];
  if (
   !prefix(before.branch, after.branch) ||
   added.length !== 1 ||
   !entry ||
   after.branch.at(-1)?.id !== entry.id ||
   entry.type !== "custom" ||
   entry.customType !== SESSION_PROFILE_CUSTOM_TYPE ||
   !isDeepStrictEqual(entry.data, payload) ||
   s.failed.has(entry.id)
  ) {
   s.ambiguous = true;
   s.uncertain = true;
   return unavailable("append-record-ambiguous");
  }
  try {
   const observed = authority(after, s);
   if (!stable(after)) return unavailable("source-changed");
   if (
    observed.state.status !== "indeterminate" &&
    observed.state.entryIndex === after.branch.length - 1
   ) {
    s.ambiguous = false;
    s.certified.set(entry.id, detached(entry));
    return detached({ status: "persisted", state: observed.state });
   }
   // The new exact explicit record is locally witnessed, not restored memory.
   if (preflush && observed.preflush) {
    s.pending = detached(entry);
    return detached({
     status: "not-persisted",
     state: readSessionProfileEntry(entry),
    });
   }
   // Reported as not adopted: a later disk recovery must not adopt it
   // silently. Only a fresh explicit, corroborated bind or clear recovers.
   s.uncertain = true;
   return unavailable("append-not-corroborated");
  } catch {
   s.uncertain = true;
   return unavailable("append-not-corroborated");
  }
 }
 function attachment(): SessionProfileAttachment {
  const epoch = generation;
  const live = () => source !== undefined && epoch === generation;
  return {
   bind: (name, models) =>
    live()
     ? append(createSessionProfileBind(name, models))
     : unavailable("detached-source"),
   clear: () =>
    live()
     ? append(createSessionProfileClear())
     : unavailable("detached-source"),
   refresh: () => (live() ? refresh() : unavailable("detached-source")),
  };
 }
 function negativeEvidence(path: Entry[], s?: Scope) {
  const failed = new Set<string>(),
   untrusted = new Set<string>();
  for (const entry of path) {
   if (!isSessionProfileFamilyEntry(entry)) continue;
   if (s?.failed.has(entry.id)) failed.add(entry.id);
   if (
    s?.untrusted.has(entry.id) ||
    (s?.uncertain && !isDeepStrictEqual(s.certified.get(entry.id), entry))
   )
    untrusted.add(entry.id);
  }
  return { failed, untrusted, ambiguous: s?.ambiguous ?? false };
 }
 function captureForkEvidence(
  target: SessionProfileForkTarget,
  view: SessionProfileForkView,
 ): SessionProfileForkEvidence {
  try {
   if (
    source !== view ||
    !target.entryId ||
    !["at", "before"].includes(target.position)
   )
    throw new Error("fork-source");
   const c = capture();
   const selected = detached(view.getEntry(target.entryId)) as Entry & {
    message?: { role?: string };
   };
   if (
    !selected ||
    selected.id !== target.entryId ||
    (target.position === "before" &&
     (selected.type !== "message" || selected.message?.role !== "user"))
   )
    throw new Error("fork-target");
   const leaf =
    target.position === "at"
     ? selected.id
     : (selected.parentId as string | null);
   if (leaf !== null && (typeof leaf !== "string" || !leaf))
    throw new Error("fork-target");
   const raw = leaf === null ? [] : view.getBranch(leaf);
   if (!Array.isArray(raw)) throw new Error("fork-path");
   for (const value of raw) {
    if (!value || typeof value !== "object") throw new Error("fork-metadata");
    const e = value as Entry;
    if (
     isSessionProfileFamilyEntry(e) &&
     !hasSessionProfileCandidateMetadata(e)
    )
     throw new Error("fork-metadata");
   }
   const path = detached(raw) as Entry[];
   if (
    (leaf !== null && path.at(-1)?.id !== leaf) ||
    path.some((e) => typeof e.id !== "string" || !e.id) ||
    new Set(path.map((e) => e.id)).size !== path.length ||
    !stable(c)
   )
    throw new Error("fork-path");
   const s = scopes.get(c.session)?.get(c.file);
   const token = Object.freeze({}) as SessionProfileForkPreparation;
   forkStore().preparations.set(token, {
    owner: identity,
    generation,
    source,
    scope: c,
    path,
    leaf,
    ...negativeEvidence(path, s),
   });
   return { status: "captured", evidence: token };
  } catch {
   return { status: "indeterminate", reason: "unobservable-fork" };
  }
 }
 function detach(
  context?: SessionProfileDetachContext,
 ): SessionProfileForkHandoff | undefined {
  let token: SessionProfileForkHandoff | undefined;
  try {
   if (context?.reason === "fork" && context.preparation) {
    const prepared = forkStore().preparations.get(context.preparation);
    const current = capture();
    if (
     !prepared ||
     prepared.owner !== identity ||
     prepared.generation !== generation ||
     prepared.source !== source ||
     !sameScope(prepared.scope, current)
    )
     throw new Error("fork-preparation");
    const view = source as SessionProfileForkView;
    const path =
     prepared.leaf === null ? [] : detached(view.getBranch(prepared.leaf));
    if (
     !isDeepStrictEqual(prepared.path, path) ||
     !stable(current) ||
     (current.file !== undefined && !context.targetSessionFile)
    )
     throw new Error("fork-transition");
    const latest = negativeEvidence(
     prepared.path,
     scopes.get(current.session)?.get(current.file),
    );
    token = Object.freeze({}) as SessionProfileForkHandoff;
    forkStore().transfers.set(token, {
     ...prepared,
     failed: new Set([...prepared.failed, ...latest.failed]),
     untrusted: new Set([...prepared.untrusted, ...latest.untrusted]),
     ambiguous: prepared.ambiguous || latest.ambiguous,
     targetFile: context.targetSessionFile,
     consumed: false,
    });
    forkStore().preparations.delete(context.preparation);
   }
  } catch {
   token = undefined;
  }
  // Even a failed proof capture must release the old runtime capability.
  for (const files of scopes.values())
   for (const s of files.values()) s.pending = undefined;
  generation++;
  source = undefined;
  appendEntry = undefined;
  readFile = undefined;
  active = undefined;
  return token;
 }
 function applyFork(
  context: SessionProfileAttachContext,
  c: Capture,
  s: Scope,
 ) {
  const claim = context.fork;
  const evidence = claim && forkStore().transfers.get(claim.handoff);
  if (!claim || !evidence || evidence.consumed) throw new Error("fork-handoff");
  evidence.consumed = true;
  const view = claim.publicView;
  const header = detached(view.getHeader()) as {
   type?: string;
   id?: string;
   parentSession?: string;
  };
  if (
   view !== source ||
   c.session === evidence.scope.session ||
   c.file !== evidence.targetFile ||
   context.previousSessionFile !== evidence.scope.file ||
   !header ||
   header.type !== "session" ||
   header.id !== c.session ||
   header.parentSession !== evidence.scope.file ||
   (c.file === undefined && view !== evidence.source)
  )
   throw new Error("fork-destination");
  const expected = evidence.path.filter((e) => e.type !== "label");
  // The source cut may itself be a removed label. Its destination boundary is
  // the last retained record, not an original label ID or a recreated label.
  const copyLeaf = expected.at(-1)?.id ?? null;
  // Validate the actual destination cut, not a matching ancestor subbranch.
  // Recreated labels may follow the cut, but no later retained record may.
  const copied = c.branch.filter((e) => e.type !== "label");
  // Orphan recovery can produce a suffix, not a fabricated complete ancestry.
  const suffix = expected.slice(expected.length - copied.length);
  if (
   copied.length > expected.length ||
   copied.length !== suffix.length ||
   (copied.at(-1)?.id ?? null) !== copyLeaf
  )
   throw new Error("fork-path");
  const replacements = new Map<string, string>();
  let labels: string[] = [];
  for (const e of evidence.path) {
   if (e.type === "label") {
    labels.push(e.id);
    continue;
   }
   for (const id of labels) replacements.set(id, e.id);
   labels = [];
  }
  let parentId: string | null = null;
  for (let index = 0; index < copied.length; index++) {
   const from = suffix[index],
    to = copied[index];
   const rewritten: Entry = { ...from, parentId };
   if (from.type === "compaction")
    rewritten.firstKeptEntryId =
     replacements.get(from.firstKeptEntryId as string) ?? from.firstKeptEntryId;
   if (!isDeepStrictEqual(rewritten, to)) throw new Error("fork-record");
   parentId = to.id;
   if (evidence.failed.has(to.id)) s.failed.add(to.id);
   if (evidence.untrusted.has(to.id)) s.untrusted.add(to.id);
  }
  if (!stable(c)) throw new Error("fork-source-changed");
  if (copied.some(isSessionProfileFamilyEntry) && evidence.ambiguous) {
   s.ambiguous = true;
   s.uncertain = true;
  }
 }
 // Optional callbacks belong to this attachment, not the retained owner.
 // Omitted options use the default disk reader, never the factory's old reader.
 function attach(
  currentSource: SessionProfileSource,
  currentAppend: (customType: string, data: unknown) => void,
  context: SessionProfileAttachContext,
  currentOptions: SessionProfileAppendOptions = {},
 ): SessionProfileAttachment {
  detach();
  source = currentSource;
  appendEntry = currentAppend;
  readFile =
   currentOptions.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  scopes = sourceScopes.get(currentSource) ?? new Map();
  sourceScopes.set(currentSource, scopes);
  if (context.reason === "fork") {
   try {
    const c = capture();
    applyFork(context, c, scope(c));
   } catch {
    // A fresh explicit disk-corroborated bind/clear can recover; no fallback.
    try {
     const s = scope(capture());
     s.ambiguous = true;
     s.uncertain = true;
    } catch {
     /* Source remains unobservable. */
    }
   }
  }
  return attachment();
 }
 return { ...attachment(), captureForkEvidence, detach, attach };
}
