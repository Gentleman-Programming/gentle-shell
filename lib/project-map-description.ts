import { readProjectMapWorkUnit, type ProjectMapDescription } from "./shell-project-map-draft.ts";

// What a capability IS, in the project's own words.
//
// The map cannot answer that: `extractWorkUnits` preserves the work unit's bold label in
// `outcome`, while the description lives in the indented body under that checkbox line. The
// shared draft-module reader owns that label and body contract so the generator and explanation
// cannot drift or import each other.

export type { ProjectMapDescription } from "./shell-project-map-draft.ts";

/**
 * The body of the work unit whose title normalizes to `capabilityId`, or `null` when the
 * document declares no such work unit. A work unit with no body answers with an empty list
 * rather than `null`, because "this document says nothing more" and "this document does not
 * declare it" are different answers.
 */
export function readCapabilityDescription(documentText: string, capabilityId: string, rowCode?: string): ProjectMapDescription | null {
	if (capabilityId.trim().length === 0) return null;
	return readProjectMapWorkUnit(documentText, capabilityId, rowCode);
}
