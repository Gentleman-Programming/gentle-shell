import assert from "node:assert/strict";
import test from "node:test";
import {
	hashProjectMapDescription,
	renderProjectMapTranslationReport,
	projectMapTranslationFor,
	projectMapTranslationWorklist,
	readProjectMapTranslations,
	PROJECT_MAP_TRANSLATIONS_LANGUAGE,
	PROJECT_MAP_TRANSLATIONS_VERSION,
} from "../lib/project-map-translations.ts";

test("the shared report preserves the exact translation worklist text", () => {
	assert.equal(renderProjectMapTranslationReport({
		worklist: { fresh: 1, items: [{ capabilityId: "catalog", source: "odd/tasks/a.md", sourceHash: "sha256:copy-me", state: "stale" }], withoutDocument: ["shipping"] },
		targetExists: false, diagnostics: ["invalid target"],
	}), [
		"Project Map translations · es",
		"Target: openspec/project-map.es.json (does not exist yet)",
		"Already translated: 1 · need a pass: 1 · no document: 1",
		"The target could not be used: invalid target",
		"",
		"Needs a pass — capability, body hash, document:",
		"  catalog  sha256:copy-me  odd/tasks/a.md  (stale)",
		"",
		"Read each document, translate that work unit's title and body into Spanish, and write the target with this shape:",
		'{"version":"gentle-pi.project-map-translations/v1","language":"es","capabilities":{"<capability-id>":{"source":"<document path>","sourceHash":"<hash from the list>","title":"<translated title>","lines":["<translated line>"]}}}',
		"Copy each hash verbatim: it identifies the body that was translated, and the explanation only shows a translation whose hash still matches.",
		"",
		"No document to translate: shipping",
	].join("\n"));
});

test("the shared report preserves the current translation text without a worklist or shape", () => {
	assert.equal(renderProjectMapTranslationReport({ worklist: { fresh: 2, items: [], withoutDocument: [] }, targetExists: true, diagnostics: [] }), [
		"Project Map translations · es",
		"Target: openspec/project-map.es.json",
		"Already translated: 2 · need a pass: 0 · no document: 0",
		"Every capability the map declares with a document is translated and current.",
	].join("\n"));
});

const BODY = ["One line.", "Another line."];
const HASH = hashProjectMapDescription(BODY);

function sidecar(capabilities: Record<string, unknown>): string {
	return JSON.stringify({ version: PROJECT_MAP_TRANSLATIONS_VERSION, language: PROJECT_MAP_TRANSLATIONS_LANGUAGE, capabilities });
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { source: "odd/tasks/fp-1b.md", sourceHash: HASH, title: "Cerrar la compuerta", lines: ["Una línea.", "Otra línea."], ...overrides };
}

test("hashes the body the reader shows, and only that", () => {
	assert.equal(HASH.startsWith("sha256:"), true);
	assert.equal(hashProjectMapDescription(BODY), hashProjectMapDescription(["One line.", "Another line."]));
	assert.notEqual(hashProjectMapDescription(BODY), hashProjectMapDescription(["One line."]));
	assert.notEqual(hashProjectMapDescription(BODY), hashProjectMapDescription(["One line.", "Another line changed."]));
	// The hash is over the reader's own output, which has already collapsed every run of
	// whitespace and carries no newline inside a line, so the join separator is unambiguous.
	assert.notEqual(hashProjectMapDescription(["One line. Another line."]), hashProjectMapDescription(BODY));
});

test("decodes the strict shape and refuses anything else whole", () => {
	const ok = readProjectMapTranslations(sidecar({ catalog: entry() }));
	assert.equal(ok.diagnostics.length, 0);
	assert.deepEqual(ok.translations?.capabilities.catalog?.lines, ["Una línea.", "Otra línea."]);

	const refusals: Array<[string, string]> = [
		["{ not json", "not valid JSON"],
		["[]", "not an object"],
		[JSON.stringify({ version: "other/v1", language: "es", capabilities: {} }), "declares version"],
		[JSON.stringify({ version: PROJECT_MAP_TRANSLATIONS_VERSION, language: "en", capabilities: {} }), "declares language"],
		[JSON.stringify({ version: PROJECT_MAP_TRANSLATIONS_VERSION, language: "es" }), "no capabilities object"],
		[sidecar({ catalog: "nope" }), "is not an object"],
		[sidecar({ catalog: entry({ source: "" }) }), "declares no source"],
		[sidecar({ catalog: entry({ sourceHash: "" }) }), "declares no sourceHash"],
		[sidecar({ catalog: entry({ title: 7 }) }), "non-string title"],
		[sidecar({ catalog: entry({ lines: "nope" }) }), "no lines array"],
		[sidecar({ catalog: entry({ lines: [1] }) }), "no lines array"],
	];
	for (const [raw, fragment] of refusals) {
		const read = readProjectMapTranslations(raw);
		assert.equal(read.translations, null, fragment);
		assert.ok(read.diagnostics.some((diagnostic) => diagnostic.includes(fragment)), `${fragment}: ${read.diagnostics.join(" | ")}`);
	}
});

test("keeps a title optional and drops an empty one", () => {
	const read = readProjectMapTranslations(sidecar({ a: entry({ title: undefined }), b: entry({ title: "" }) }));
	assert.equal(read.translations?.capabilities.a?.title, undefined);
	assert.equal(read.translations?.capabilities.b?.title, undefined);
});

test("tells missing from stale from fresh", () => {
	const translations = readProjectMapTranslations(sidecar({ catalog: entry() })).translations!;
	assert.equal(projectMapTranslationFor(translations, "catalog", BODY).state, "fresh");
	assert.equal(projectMapTranslationFor(translations, "catalog", ["Changed."]).state, "stale");
	assert.equal(projectMapTranslationFor(translations, "billing", BODY).state, "missing");
	assert.equal(projectMapTranslationFor(translations, "catalog", BODY).translation?.lines[0], "Una línea.");
	assert.equal(projectMapTranslationFor(translations, "catalog", ["Changed."]).translation, null, "a stale entry is never shown");
});

test("the work list names what still needs a pass, and separates what has no document", () => {
	const capabilities = [
		{ id: "catalog", source: "odd/tasks/a.md", lines: BODY },
		{ id: "billing", source: "odd/tasks/a.md", lines: ["Other."] },
		{ id: "shipping", source: null, lines: null },
	];
	const translations = readProjectMapTranslations(sidecar({ catalog: entry() })).translations!;
	const list = projectMapTranslationWorklist(capabilities, translations);
	assert.equal(list.fresh, 1);
	assert.deepEqual(list.withoutDocument, ["shipping"]);
	assert.deepEqual(list.items.map((item) => [item.capabilityId, item.state]), [["billing", "missing"]]);

	const empty = projectMapTranslationWorklist(capabilities, null);
	assert.equal(empty.fresh, 0);
	assert.deepEqual(empty.items.map((item) => item.capabilityId), ["catalog", "billing"]);
	assert.equal(empty.items[0]?.sourceHash, HASH, "the work list carries the hash the writer has to copy");
});
