// Observable append authority; no SDK, lifecycle seams or consumers.
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
export interface SessionProfileAttachment {
 bind(
  name: string,
  models: SessionProfileBindPayload["modelProfiles"],
 ): SessionProfileAppendOutcome;
 clear(): SessionProfileAppendOutcome;
 refresh(): SessionProfileAppendOutcome;
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
 * for each source/session/file.
 * Corroboration does not promise fsync, full ancestry or external-writer safety.
 */
export function createSessionProfileAppendController(
 initialSource: SessionProfileSource,
 initialAppendEntry: (customType: string, data: unknown) => void,
 options: SessionProfileAppendOptions = {},
) {
 const scopes = new Map<string, Map<string | undefined, Scope>>();
 const source = initialSource;
 const appendEntry = initialAppendEntry;
 let active: Scope | undefined;
 const readFile =
  options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
 function capture(): Capture {
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
   s.uncertain &&
   (!latest || !isDeepStrictEqual(s.certified.get(latest.id), latest))
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
 return {
  bind: (name, models) => append(createSessionProfileBind(name, models)),
  clear: () => append(createSessionProfileClear()),
  refresh,
 } satisfies SessionProfileAttachment;
}
