// Current admission/publication bridge. Controller evidence stays in the
// integration owner; this module owns no quarantine, capability or cache.
import { existsSync } from "node:fs";
import { readSessionProfileDisk } from "./session-profile-disk-reader.ts";
import {
 readCurrentSessionProfileOutcome,
 type SessionProfileLifecycleManager,
} from "./session-profile-integration.ts";
import type { SessionProfileAppendOutcome } from "./session-profile-append-controller.ts";
import {
 bindSessionProfile,
 clearSessionProfileBinding,
 readSessionProfileBinding,
 type SessionProfileBinding,
} from "./session-profile-binding.ts";

export type SessionProfileAuthority =
 | { available: true; binding?: SessionProfileBinding }
 | { available: false };

/** Publish only the returned detached snapshot, including preserved disk state
 * on append failure. Terminal invalid/future records never expose a fallback.
 */
export function publishSessionProfileOutcome(
 manager: SessionProfileLifecycleManager,
 outcome: SessionProfileAppendOutcome,
): SessionProfileAuthority {
 const id = manager.getSessionId();
 const state = outcome.state;
 if (state.status === "bound") {
  bindSessionProfile(id, state.binding.name, state.binding.modelProfiles);
  return { available: true, binding: readSessionProfileBinding(id) };
 }
 clearSessionProfileBinding(id);
 return state.status === "absent" || state.status === "cleared"
  ? { available: true }
  : { available: false };
}

function noProfile(manager: SessionProfileLifecycleManager): boolean {
 const entries = manager.getBranch();
 return (
  Array.isArray(entries) &&
  !entries.some((entry) => {
   if (!entry || typeof entry !== "object") return true;
   const value = entry as { type?: unknown; customType?: unknown };
   return (
    value.type === "custom" &&
    typeof value.customType === "string" &&
    value.customType.startsWith("gentle-pi.session-profile/")
   );
  })
 );
}

/** Load-order independent read. Without an owner, disk is read-only authority;
 * with an owner, every request revalidates its existing negative evidence.
 * An ordinary empty/preflush branch with no profile meaning retains its legacy
 * routing. Missing disk never restores a profile found only in memory.
 */
export function readSessionProfileAuthority(
 manager: SessionProfileLifecycleManager,
): SessionProfileAuthority {
 try {
  const id = manager.getSessionId(),
   file = manager.getSessionFile?.();
  if (!id) return { available: false };
  const owned = readCurrentSessionProfileOutcome(manager);
  const outcome = owned ?? {
   status: "persisted" as const,
   state: readSessionProfileDisk(manager),
  };
  const empty =
   outcome.state.status === "indeterminate" &&
   ["missing-source", "unreadable-file"].includes(outcome.state.reason) &&
   noProfile(manager) &&
   (file === undefined || !existsSync(file));
  if (manager.getSessionId() !== id || manager.getSessionFile?.() !== file)
   return { available: false };
  if (empty) {
   if (owned) clearSessionProfileBinding(id);
   return {
    available: true,
    binding: owned ? undefined : readSessionProfileBinding(id),
   };
  }
  return publishSessionProfileOutcome(manager, outcome);
 } catch {
  try {
   clearSessionProfileBinding(manager.getSessionId());
  } catch {
   /* Unobservable manager. */
  }
  return { available: false };
 }
}

export function requireSessionProfileAuthority(
 manager: SessionProfileLifecycleManager,
): SessionProfileAuthority & { available: true } {
 const authority = readSessionProfileAuthority(manager);
 if (!authority.available)
  throw new Error(
   "Session profile authority unavailable; affected launches are blocked until corroborated state or an explicit selection is available.",
  );
 return authority;
}
