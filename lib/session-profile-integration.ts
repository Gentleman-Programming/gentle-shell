// Lifecycle adapter only: no extension registration, binding publication or UI.
import {
 createSessionProfileAppendController,
 type SessionProfileAppendOptions,
 type SessionProfileAppendOutcome,
 type SessionProfileAttachment,
 type SessionProfileForkView,
 type SessionProfileForkTarget,
 type SessionProfileForkPreparation,
 type SessionProfileForkHandoff,
} from "./session-profile-append-controller.ts";

export type SessionProfileLifecycleManager = SessionProfileForkView;
export type SessionProfileLifecycleReason =
 | "startup"
 | "reload"
 | "new"
 | "resume"
 | "fork";
type Owner = {
 controller: ReturnType<typeof createSessionProfileAppendController>;
 adapter: object;
 attachment?: SessionProfileAttachment;
 preparation?: SessionProfileForkPreparation;
 outgoing?: Transfer;
 pending?: Promise<void>;
};
type Transfer = {
 manager: SessionProfileLifecycleManager;
 previousFile?: string;
 targetFile?: string;
 handoff?: SessionProfileForkHandoff;
};
type Registry = {
 version: 1;
 owners: WeakMap<object, Owner>;
 transfers: Set<Transfer>;
};
// Stable key, explicit protocol: a new implementation must not reset evidence.
const registryKey = Symbol.for("gentle-pi.session-profile.lifecycle");
function registry(): Registry {
 const existing = Reflect.get(globalThis, registryKey) as Registry | undefined;
 if (existing) {
  if (
   existing.version !== 1 ||
   !(existing.owners instanceof WeakMap) ||
   !(existing.transfers instanceof Set)
  )
   throw new Error("lifecycle-protocol");
  return existing;
 }
 const value: Registry = {
  version: 1,
  owners: new WeakMap(),
  transfers: new Set(),
 };
 Object.defineProperty(globalThis, registryKey, { value });
 return value;
}
function unavailable(): SessionProfileAppendOutcome {
 return {
  status: "indeterminate",
  state: { status: "indeterminate", reason: "unavailable-lifecycle" },
 };
}
function inactive(): SessionProfileAttachment {
 return { bind: unavailable, clear: unavailable, refresh: unavailable };
}
/** Read/revalidate the existing owner without adopting its adapter identity. */
export function readCurrentSessionProfileOutcome(
 manager: SessionProfileLifecycleManager,
): SessionProfileAppendOutcome | undefined {
 try {
  const owner = registry().owners.get(manager);
  return owner ? (owner.attachment?.refresh() ?? unavailable()) : undefined;
 } catch {
  return unavailable();
 }
}

/** Serialize explicit selections; lifecycle hooks drain this same owner queue.
 * The promise is transient work, not another quarantine or authority store.
 */
export async function runCurrentSessionProfileSelection<T>(
 manager: SessionProfileLifecycleManager,
 effect: (
  attachment: SessionProfileAttachment,
  current: () => boolean,
 ) => Promise<T>,
): Promise<T | undefined> {
 const owner = registry().owners.get(manager);
 if (!owner?.attachment) return undefined;
 const attachment = owner.attachment,
  adapter = owner.adapter;
 const id = manager.getSessionId(),
  file = manager.getSessionFile();
 const current = () =>
  registry().owners.get(manager) === owner &&
  owner.adapter === adapter &&
  owner.attachment === attachment &&
  manager.getSessionId() === id &&
  manager.getSessionFile() === file;
 const operation = (owner.pending ?? Promise.resolve()).then(() =>
  current() ? effect(attachment, current) : undefined,
 );
 const pending = operation.then(
  () => {},
  () => {},
 );
 owner.pending = pending;
 try {
  return await operation;
 } finally {
  if (owner.pending === pending) owner.pending = undefined;
 }
}

/** Await before fork-copy/tree movement and before detach/invalidation. */
export async function waitCurrentSessionProfileSelection(
 manager: SessionProfileLifecycleManager,
): Promise<void> {
 let pending: Promise<void> | undefined;
 while ((pending = registry().owners.get(manager)?.pending)) await pending;
}

/** The registry retains controller evidence, never old ctx/pi or append handles.
 * Manager identity covers same-process reload only. Replacements require an
 * exact, uniquely matched confirmed handoff; paths alone never restore binding.
 */
export function createSessionProfileIntegration(
 options: SessionProfileAppendOptions = {},
) {
 const identity = {};
 function owned(manager: SessionProfileLifecycleManager): Owner | undefined {
  const owner = registry().owners.get(manager);
  return owner?.adapter === identity ? owner : undefined;
 }
 function forget(owner: Owner) {
  if (owner.outgoing) registry().transfers.delete(owner.outgoing);
  owner.outgoing = undefined;
 }
 return {
  isCurrent(manager: SessionProfileLifecycleManager): boolean {
   return owned(manager)?.attachment !== undefined;
  },
  start(
   manager: SessionProfileLifecycleManager,
   append: (type: string, data: unknown) => void,
   event: {
    reason: SessionProfileLifecycleReason;
    previousSessionFile?: string;
   },
  ) {
   let owner: Owner | undefined;
   try {
    const store = registry();
    owner = store.owners.get(manager);
    if (!owner) {
     owner = {
      controller: createSessionProfileAppendController(
       manager,
       append,
       options,
      ),
      adapter: identity,
     };
     store.owners.set(manager, owner);
    }
    owner.controller.detach();
    owner.adapter = identity;
    owner.preparation = undefined;
    const location = {
     sessionId: manager.getSessionId(),
     sessionFile: manager.getSessionFile(),
    };
    let handoff: SessionProfileForkHandoff | undefined;
    if (event.reason === "fork") {
     const candidates = [...store.transfers].filter(
      (t) =>
       t.previousFile === event.previousSessionFile &&
       t.targetFile === location.sessionFile &&
       (location.sessionFile !== undefined || t.manager === manager),
     );
     // Consume even a conflicting match so later starts cannot retry it.
     for (const candidate of candidates) store.transfers.delete(candidate);
     if (candidates.length === 1) handoff = candidates[0].handoff;
    }
    forget(owner);
    owner.attachment = owner.controller.attach(
     manager,
     append,
     {
      reason: event.reason,
      previousSessionFile: event.previousSessionFile,
      ...(handoff ? { fork: { handoff, publicView: manager } } : {}),
     },
     options,
    );
    const outcome = owner.attachment.refresh();
    const stable =
     manager.getSessionId() === location.sessionId &&
     manager.getSessionFile() === location.sessionFile;
    return {
     attachment: owner.attachment,
     outcome: stable ? outcome : unavailable(),
     scope: location,
    };
   } catch {
    owner?.controller.detach();
    if (owner) owner.attachment = undefined;
    return { attachment: inactive(), outcome: unavailable(), scope: undefined };
   }
  },
  beforeFork(
   manager: SessionProfileLifecycleManager,
   target: SessionProfileForkTarget,
  ) {
   try {
    const owner = owned(manager);
    if (!owner?.attachment)
     return {
      status: "indeterminate" as const,
      reason: "unavailable-lifecycle",
     };
    forget(owner);
    const result = owner.controller.captureForkEvidence(target, manager);
    owner.preparation =
     result.status === "captured" ? result.evidence : undefined;
    return result;
   } catch {
    return {
     status: "indeterminate" as const,
     reason: "unavailable-lifecycle",
    };
   }
  },
  shutdown(
   manager: SessionProfileLifecycleManager,
   event: {
    reason: SessionProfileLifecycleReason | "quit";
    targetSessionFile?: string;
   },
  ) {
   try {
    const owner = owned(manager);
    if (!owner) return;
    forget(owner);
    const previousFile = manager.getSessionFile();
    const handoff = owner.controller.detach({
     reason: event.reason === "startup" ? "quit" : event.reason,
     targetSessionFile: event.targetSessionFile,
     preparation: owner.preparation,
    });
    owner.attachment = undefined;
    owner.preparation = undefined;
    if (event.reason === "fork") {
     const transfer = {
      manager,
      previousFile,
      targetFile: event.targetSessionFile,
      handoff,
     };
     registry().transfers.add(transfer);
     owner.outgoing = transfer;
    }
   } catch {
    // Cleanup still revokes capabilities when observing the transition fails.
    try {
     const owner = owned(manager);
     owner?.controller.detach();
     if (owner) owner.attachment = undefined;
    } catch {
     /* Protocol itself is unavailable. */
    }
   }
  },
  tree(manager: SessionProfileLifecycleManager): SessionProfileAppendOutcome {
   try {
    return owned(manager)?.attachment?.refresh() ?? unavailable();
   } catch {
    return unavailable();
   }
  },
 };
}
