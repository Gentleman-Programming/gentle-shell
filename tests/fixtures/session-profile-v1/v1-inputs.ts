// Inputs of the vendored v1 session-profile chain (gentle-shell#2742, section 10).
// The `session-profile-*.ts` files beside this one are byte-identical copies of
// the `lib/` modules of the last release before A2 except their import lines.
// What A2 does not change is read live, so both versions see the same pins,
// declarations and profiles store. A replay reads the record from disk with no
// lifecycle owner, as a resumed v1 session does.
import type { SessionProfileAppendOutcome } from "../../../lib/session-profile-append-controller.ts";
import type { SessionProfileLifecycleManager } from "../../../lib/session-profile-integration.ts";

export { isValidProfileName, profileRoleEntries, profilesFilePath, readProfilesFileResult } from "../../../lib/agent-profiles.ts";
export { readProfilePinStatus, resolveProfilePin, resolveUnversionedProjectProfile } from "../../../lib/agent-profile-pin.ts";
export type { SessionProfileLifecycleManager };

export function readCurrentSessionProfileOutcome(_manager: SessionProfileLifecycleManager): SessionProfileAppendOutcome | undefined {
	return undefined;
}
