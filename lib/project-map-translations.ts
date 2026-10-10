import { createHash } from "node:crypto";

// The Project Map explains a capability with the body its own ODD document carries, and that body
// is written in whatever language the project writes its documents in. A reader who wants the
// explanation in Spanish cannot have the card translate it: the extension that opens the overlay
// has no model, and the read happens inside a path that must stay synchronous and cheap. So the
// translation is made once, by the agent, and stored next to the map; this module reads it back
// and decides whether it still matches the document it came from.
//
// The freshness key is the hash of the *extracted body*, not of the document: an unrelated edit
// elsewhere in the same document must not invalidate every translation the document feeds, and a
// body that changed must invalidate its own even when the file's mtime did not. Hashing the lines
// the reader would show means the hash and the thing translated are the same value.
//
// Pure on purpose: no Pi API, no filesystem, so the shape, the freshness rule and the work list
// are exercised without a session.

/** Where the translation lives, relative to the repository root. */
export const PROJECT_MAP_TRANSLATIONS_PATH = "openspec/project-map.es.json";
export const PROJECT_MAP_TRANSLATIONS_VERSION = "gentle-pi.project-map-translations/v1";
export const PROJECT_MAP_TRANSLATIONS_LANGUAGE = "es";

export interface ProjectMapTranslation {
	/** The document the translation was made from, repository-relative. */
	source: string;
	/** The hash of the body that was translated, so a changed document invalidates it. */
	sourceHash: string;
	/** The translated work-unit title. Absent keeps the original title in the explanation. */
	title?: string;
	/** The translated body, one entry per line. */
	lines: string[];
}

export interface ProjectMapTranslations {
	version: string;
	language: string;
	capabilities: Record<string, ProjectMapTranslation>;
}

export interface ProjectMapTranslationsRead {
	translations: ProjectMapTranslations | null;
	diagnostics: string[];
}

/** Why a capability's explanation is not translated right now. */
export type ProjectMapTranslationState = "fresh" | "missing" | "stale";

export interface ProjectMapTranslationLookup {
	state: ProjectMapTranslationState;
	translation: ProjectMapTranslation | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The identity of a body, as the reader extracted it. Lines are joined with a newline because
 * that is the only separator that cannot occur inside one: the reader collapses every run of
 * whitespace into a single space before returning a line.
 */
export function hashProjectMapDescription(lines: readonly string[]): string {
	return `sha256:${createHash("sha256").update(lines.join("\n"), "utf8").digest("hex")}`;
}

/**
 * Strict decode of the sidecar. Anything that does not match the version, the language and the
 * per-capability shape is refused whole rather than partially trusted: a translation that is
 * half-read is worse than one that is missing, because the reader would show a mix of languages
 * without saying so.
 */
export function readProjectMapTranslations(text: string): ProjectMapTranslationsRead {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { translations: null, diagnostics: [`${PROJECT_MAP_TRANSLATIONS_PATH} is not valid JSON.`] };
	}
	if (!isRecord(parsed)) return { translations: null, diagnostics: [`${PROJECT_MAP_TRANSLATIONS_PATH} is not an object.`] };
	if (parsed.version !== PROJECT_MAP_TRANSLATIONS_VERSION) {
		return { translations: null, diagnostics: [`${PROJECT_MAP_TRANSLATIONS_PATH} declares version "${String(parsed.version)}", not ${PROJECT_MAP_TRANSLATIONS_VERSION}.`] };
	}
	if (parsed.language !== PROJECT_MAP_TRANSLATIONS_LANGUAGE) {
		return { translations: null, diagnostics: [`${PROJECT_MAP_TRANSLATIONS_PATH} declares language "${String(parsed.language)}", not ${PROJECT_MAP_TRANSLATIONS_LANGUAGE}.`] };
	}
	if (!isRecord(parsed.capabilities)) return { translations: null, diagnostics: [`${PROJECT_MAP_TRANSLATIONS_PATH} declares no capabilities object.`] };
	const capabilities: Record<string, ProjectMapTranslation> = {};
	for (const [capabilityId, value] of Object.entries(parsed.capabilities)) {
		if (!isRecord(value)) return { translations: null, diagnostics: [`${PROJECT_MAP_TRANSLATIONS_PATH} entry "${capabilityId}" is not an object.`] };
		const { source, sourceHash, title, lines } = value;
		if (typeof source !== "string" || source.length === 0) return { translations: null, diagnostics: [`${PROJECT_MAP_TRANSLATIONS_PATH} entry "${capabilityId}" declares no source.`] };
		if (typeof sourceHash !== "string" || sourceHash.length === 0) return { translations: null, diagnostics: [`${PROJECT_MAP_TRANSLATIONS_PATH} entry "${capabilityId}" declares no sourceHash.`] };
		if (title !== undefined && typeof title !== "string") return { translations: null, diagnostics: [`${PROJECT_MAP_TRANSLATIONS_PATH} entry "${capabilityId}" has a non-string title.`] };
		if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) return { translations: null, diagnostics: [`${PROJECT_MAP_TRANSLATIONS_PATH} entry "${capabilityId}" has no lines array of strings.`] };
		capabilities[capabilityId] = { source, sourceHash, lines: lines as string[], ...(typeof title === "string" && title.length > 0 ? { title } : {}) };
	}
	return { translations: { version: PROJECT_MAP_TRANSLATIONS_VERSION, language: PROJECT_MAP_TRANSLATIONS_LANGUAGE, capabilities }, diagnostics: [] };
}

/**
 * The translation for one capability, and whether it still matches the body it was made from.
 *
 * A capability the file does not mention is `missing`, and one whose body hash moved is `stale`:
 * the explanation then shows the document's own words, and the difference between the two is
 * what the reader is told.
 */
export function projectMapTranslationFor(
	translations: ProjectMapTranslations,
	capabilityId: string,
	lines: readonly string[],
): ProjectMapTranslationLookup {
	const translation = translations.capabilities[capabilityId];
	if (translation === undefined) return { state: "missing", translation: null };
	if (translation.sourceHash !== hashProjectMapDescription(lines)) return { state: "stale", translation: null };
	return { state: "fresh", translation };
}

export interface ProjectMapTranslationWorkItem {
	capabilityId: string;
	source: string;
	sourceHash: string;
	state: ProjectMapTranslationState;
}

export interface ProjectMapTranslationWorklist {
	items: ProjectMapTranslationWorkItem[];
	fresh: number;
	/** Capabilities the map declares with no document to translate. */
	withoutDocument: string[];
}

/**
 * What a translation pass still has to do, in the map's own order. The hash is reported by the
 * caller rather than computed here, because only the caller reads the documents: this keeps the
 * work list honest about which bodies it actually saw.
 */
export function projectMapTranslationWorklist(
	capabilities: readonly { id: string; source: string | null; lines: readonly string[] | null }[],
	translations: ProjectMapTranslations | null,
): ProjectMapTranslationWorklist {
	const items: ProjectMapTranslationWorkItem[] = [];
	const withoutDocument: string[] = [];
	let fresh = 0;
	for (const capability of capabilities) {
		if (capability.source === null || capability.lines === null) {
			withoutDocument.push(capability.id);
			continue;
		}
		const lookup = translations === null ? { state: "missing" as const, translation: null } : projectMapTranslationFor(translations, capability.id, capability.lines);
		if (lookup.state === "fresh") fresh += 1;
		else items.push({ capabilityId: capability.id, source: capability.source, sourceHash: hashProjectMapDescription(capability.lines), state: lookup.state });
	}
	return { items, fresh, withoutDocument };
}

/**
 * Both command readers hand the agent the same report. Keeping its text here means a refresh
 * cannot ask for a different translation shape than the explicit, read-only translation pass.
 */
export function renderProjectMapTranslationReport(input: {
	worklist: ProjectMapTranslationWorklist;
	targetExists: boolean;
	diagnostics: readonly string[];
}): string {
	const { worklist, targetExists, diagnostics } = input;
	return [
		`Project Map translations · ${PROJECT_MAP_TRANSLATIONS_LANGUAGE}`,
		`Target: ${PROJECT_MAP_TRANSLATIONS_PATH}${targetExists ? "" : " (does not exist yet)"}`,
		`Already translated: ${worklist.fresh} · need a pass: ${worklist.items.length} · no document: ${worklist.withoutDocument.length}`,
		...diagnostics.map((diagnostic) => `The target could not be used: ${diagnostic}`),
		...(worklist.items.length === 0
			? ["Every capability the map declares with a document is translated and current."]
			: [
				"",
				"Needs a pass — capability, body hash, document:",
				...worklist.items.map((item) => `  ${item.capabilityId}  ${item.sourceHash}  ${item.source}${item.state === "stale" ? "  (stale)" : ""}`),
				"",
				"Read each document, translate that work unit's title and body into Spanish, and write the target with this shape:",
				renderProjectMapTranslationShape(),
				"Copy each hash verbatim: it identifies the body that was translated, and the explanation only shows a translation whose hash still matches.",
			]),
		...(worklist.withoutDocument.length === 0 ? [] : ["", `No document to translate: ${worklist.withoutDocument.join(", ")}`]),
	].join("\n");
}

/** The shape the agent writes, printed once so the file it produces cannot drift from the reader. */
export function renderProjectMapTranslationShape(): string {
	return JSON.stringify({
		version: PROJECT_MAP_TRANSLATIONS_VERSION,
		language: PROJECT_MAP_TRANSLATIONS_LANGUAGE,
		capabilities: { "<capability-id>": { source: "<document path>", sourceHash: "<hash from the list>", title: "<translated title>", lines: ["<translated line>"] } },
	});
}
