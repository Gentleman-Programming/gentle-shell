import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PROJECT_MAP_APPROVAL_STATES,
	PROJECT_MAP_ARTIFACT_PATH,
	PROJECT_MAP_DIAGNOSTIC_CODES,
	PROJECT_MAP_SCHEMA_V1,
	PROJECT_MAP_STATES,
	PROJECT_MAP_SURFACES,
	canonicalizeProjectMap,
	isSafeFeatureDocumentPath,
	parseProjectMap,
	readProjectMapFile,
	serializeProjectMap,
	validateProjectMap,
	type ProjectMapV1,
} from "../lib/shell-project-map-schema.ts";

function minimalMap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: PROJECT_MAP_SCHEMA_V1,
		project: { id: "example-shop", name: "Example Shop" },
		capabilities: [
			{
				id: "merchant-catalog",
				outcome: "Merchants can publish and manage their catalog.",
				surfaces: ["web", "api"],
				state: "active",
			},
		],
		...overrides,
	};
}

function codes(result: { diagnostics: { code: string }[] }): string[] {
	return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function paths(result: { diagnostics: { path: string }[] }): string[] {
	return result.diagnostics.map((diagnostic) => diagnostic.path);
}

test("exports the frozen v1 vocabulary", () => {
	assert.equal(PROJECT_MAP_SCHEMA_V1, "gentle-shell.project-map/v1");
	assert.deepEqual(PROJECT_MAP_DIAGNOSTIC_CODES, {
		UNSUPPORTED_SCHEMA: "project-map/unsupported-schema-version",
		UNKNOWN_FIELD: "project-map/unknown-field",
		FORBIDDEN_RUNTIME_FIELD: "project-map/forbidden-runtime-field",
		MISSING_FIELD: "project-map/missing-field",
		INVALID_FIELD: "project-map/invalid-field",
		DUPLICATE_ID: "project-map/duplicate-id",
		UNKNOWN_REFERENCE: "project-map/unknown-reference",
		DEPENDENCY_CYCLE: "project-map/dependency-cycle",
		MISSING_FEATURE_DOCUMENT: "project-map/missing-feature-document",
		INVALID_JSON: "project-map/invalid-json",
		UNREADABLE_ARTIFACT: "project-map/unreadable-artifact",
	});
	assert.deepEqual([...PROJECT_MAP_SURFACES], ["productUx", "web", "api", "data", "security", "operations", "tests"]);
	assert.deepEqual([...PROJECT_MAP_STATES], ["done", "active", "review", "ready", "blocked", "planned"]);
});

test("accepts a minimal map and applies migration-safe defaults", () => {
	const result = validateProjectMap(minimalMap());
	assert.deepEqual(result.diagnostics, []);
	assert.ok(result.map);
	assert.deepEqual(result.map.foundations, []);
	assert.deepEqual(result.map.capabilities[0].foundationRefs, []);
	assert.deepEqual(result.map.capabilities[0].dependsOn, []);
	assert.deepEqual(result.map.capabilities[0].contracts, []);
	assert.deepEqual(result.map.capabilities[0].featureDocs, []);
});

test("fails closed on an unsupported, missing, or non-string schema version", () => {
	const unsupported = validateProjectMap(minimalMap({ version: "gentle-shell.project-map/v2" }));
	assert.equal(unsupported.map, null);
	assert.deepEqual(codes(unsupported), [PROJECT_MAP_DIAGNOSTIC_CODES.UNSUPPORTED_SCHEMA]);
	assert.deepEqual(paths(unsupported), ["$.version"]);

	const missing = minimalMap();
	delete missing.version;
	const missingResult = validateProjectMap(missing);
	assert.equal(missingResult.map, null);
	assert.deepEqual(codes(missingResult), [PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD]);
	assert.deepEqual(paths(missingResult), ["$.version"]);

	const wrongType = validateProjectMap(minimalMap({ version: 1 }));
	assert.equal(wrongType.map, null);
	assert.deepEqual(codes(wrongType), [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(wrongType), ["$.version"]);
});

test("rejects unknown fields with an exact path", () => {
	const result = validateProjectMap(
		minimalMap({
			owner: "lead",
			project: { id: "example-shop", name: "Example Shop", slack: "#shop" },
			foundations: [{ id: "repo-and-envs", outcome: "Repositories exist.", state: "done", notes: "nope" }],
			capabilities: [
				{
					id: "merchant-catalog",
					outcome: "Merchants can publish and manage their catalog.",
					surfaces: ["web"],
					state: "active",
					priority: 1,
				},
			],
		}),
	);
	assert.deepEqual(codes(result), [
		PROJECT_MAP_DIAGNOSTIC_CODES.UNKNOWN_FIELD,
		PROJECT_MAP_DIAGNOSTIC_CODES.UNKNOWN_FIELD,
		PROJECT_MAP_DIAGNOSTIC_CODES.UNKNOWN_FIELD,
		PROJECT_MAP_DIAGNOSTIC_CODES.UNKNOWN_FIELD,
	]);
	assert.deepEqual(paths(result), ["$.owner", "$.project.slack", "$.foundations[0].notes", "$.capabilities[0].priority"]);
	assert.equal(result.map, null);
});

test("rejects runtime coordination fields with a dedicated code", () => {
	const result = validateProjectMap(
		minimalMap({
			generation: 4,
			capabilities: [
				{
					id: "merchant-catalog",
					outcome: "Merchants can publish and manage their catalog.",
					surfaces: ["web"],
					state: "active",
					worktree: "feat/merchant-catalog",
					lease: { owner: "session-42" },
				},
			],
		}),
	);
	assert.deepEqual(codes(result), [
		PROJECT_MAP_DIAGNOSTIC_CODES.FORBIDDEN_RUNTIME_FIELD,
		PROJECT_MAP_DIAGNOSTIC_CODES.FORBIDDEN_RUNTIME_FIELD,
		PROJECT_MAP_DIAGNOSTIC_CODES.FORBIDDEN_RUNTIME_FIELD,
	]);
	assert.deepEqual(paths(result), ["$.generation", "$.capabilities[0].worktree", "$.capabilities[0].lease"]);
});

test("reports missing required fields and invalid field values", () => {
	const result = validateProjectMap({
		version: PROJECT_MAP_SCHEMA_V1,
		project: { id: "example-shop" },
		capabilities: [
			{ id: "merchant-catalog", outcome: "", surfaces: "web", state: "in-progress" },
			{ id: "checkout", surfaces: [], state: "planned" },
		],
	});
	assert.deepEqual(codes(result), [
		PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD,
		PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD,
		PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD,
		PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD,
		PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD,
	]);
	// The map carries no approval block, so it is a draft and an empty surface list is allowed here.
	// "requires a non-empty surface list once the map is approved" pins the other half of the rule.
	assert.deepEqual(paths(result), [
		"$.project.name",
		"$.capabilities[0].outcome",
		"$.capabilities[0].surfaces",
		"$.capabilities[0].state",
		"$.capabilities[1].outcome",
	]);
});

test("rejects invalid identifiers, duplicate identifiers, and duplicate entries", () => {
	const result = validateProjectMap(
		minimalMap({
			foundations: [
				{ id: "repo-and-envs", outcome: "Repositories exist.", state: "done" },
				{ id: "repo-and-envs", outcome: "Duplicate identifier.", state: "done" },
				{ id: "Not Kebab", outcome: "Invalid identifier.", state: "done" },
			],
			capabilities: [
				{ id: "merchant-catalog", outcome: "One.", surfaces: ["web", "web"], state: "active" },
				{ id: "merchant-catalog", outcome: "Two.", surfaces: ["web"], state: "active" },
			],
		}),
	);
	assert.deepEqual(codes(result), [
		PROJECT_MAP_DIAGNOSTIC_CODES.DUPLICATE_ID,
		PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD,
		PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD,
		PROJECT_MAP_DIAGNOSTIC_CODES.DUPLICATE_ID,
	]);
	assert.deepEqual(paths(result), [
		"$.foundations[1].id",
		"$.foundations[2].id",
		"$.capabilities[0].surfaces[1]",
		"$.capabilities[1].id",
	]);
});

test("canonicalizes and serializes deterministically regardless of input order", () => {
	const first = validateProjectMap(
		minimalMap({
			capabilities: [
				{ id: "checkout", outcome: "Checkout works.", surfaces: ["api", "web"], state: "planned" },
				{ id: "admin", outcome: "Admins operate.", surfaces: ["web"], state: "ready", dependsOn: ["checkout"] },
			],
			foundations: [
				{ id: "observability", outcome: "Deploys are visible.", state: "review" },
				{ id: "repo-and-envs", outcome: "Repositories exist.", state: "done" },
			],
		}),
	);
	const second = validateProjectMap(
		minimalMap({
			foundations: [
				{ state: "done", outcome: "Repositories exist.", id: "repo-and-envs" },
				{ state: "review", outcome: "Deploys are visible.", id: "observability" },
			],
			capabilities: [
				{ state: "ready", surfaces: ["web"], dependsOn: ["checkout"], outcome: "Admins operate.", id: "admin" },
				{ state: "planned", surfaces: ["web", "api"], outcome: "Checkout works.", id: "checkout" },
			],
		}),
	);
	assert.deepEqual(first.diagnostics, []);
	assert.deepEqual(second.diagnostics, []);
	assert.equal(serializeProjectMap(first.map as ProjectMapV1), serializeProjectMap(second.map as ProjectMapV1));
	assert.deepEqual(
		(first.map as ProjectMapV1).capabilities.map((capability) => capability.id),
		["admin", "checkout"],
	);
	assert.deepEqual((first.map as ProjectMapV1).capabilities[0].surfaces, ["web"]);
	assert.deepEqual((first.map as ProjectMapV1).capabilities[1].surfaces, ["web", "api"]);
	assert.deepEqual(
		(first.map as ProjectMapV1).foundations.map((foundation) => foundation.id),
		["observability", "repo-and-envs"],
	);
	assert.equal(canonicalizeProjectMap(first.map as ProjectMapV1).capabilities[0].id, "admin");
	assert.equal(
		serializeProjectMap(canonicalizeProjectMap(first.map as ProjectMapV1)),
		serializeProjectMap(first.map as ProjectMapV1),
	);
	assert.ok(serializeProjectMap(first.map as ProjectMapV1).endsWith("\n"));
});

test("serializes hand-built maps independently of insertion order with fixed keys", () => {
	const first: ProjectMapV1 = {
		version: PROJECT_MAP_SCHEMA_V1,
		project: { id: "example-shop", name: "Example Shop" },
		approval: { state: "draft" },
		foundations: [],
		capabilities: [{ id: "merchant-catalog", outcome: "Catalog works.", foundationRefs: [], dependsOn: [], contracts: [], featureDocs: [], surfaces: ["web"], state: "active" }],
	};
	const second = {
		capabilities: [{ state: "active", surfaces: ["web"], featureDocs: [], contracts: [], dependsOn: [], foundationRefs: [], outcome: "Catalog works.", id: "merchant-catalog" }],
		foundations: [],
		approval: { state: "draft" },
		project: { name: "Example Shop", id: "example-shop" },
		version: PROJECT_MAP_SCHEMA_V1,
	} as ProjectMapV1;
	const expected = `{
  "version": "gentle-shell.project-map/v1",
  "project": {
    "id": "example-shop",
    "name": "Example Shop"
  },
  "approval": {
    "state": "draft"
  },
  "foundations": [],
  "capabilities": [
    {
      "id": "merchant-catalog",
      "outcome": "Catalog works.",
      "foundationRefs": [],
      "dependsOn": [],
      "contracts": [],
      "featureDocs": [],
      "surfaces": [
        "web"
      ],
      "state": "active"
    }
  ]
}\n`;
	assert.equal(serializeProjectMap(first), serializeProjectMap(second));
	assert.equal(serializeProjectMap(first), expected);
});

test("never throws on malformed input", () => {
	const cases: Array<{ value: unknown; expectedCodes: string[]; expectedPaths: string[] }> = [
		{ value: null, expectedCodes: [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD], expectedPaths: ["$"] },
		{ value: undefined, expectedCodes: [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD], expectedPaths: ["$"] },
		{ value: "map", expectedCodes: [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD], expectedPaths: ["$"] },
		{ value: 7, expectedCodes: [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD], expectedPaths: ["$"] },
		{ value: [], expectedCodes: [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD], expectedPaths: ["$"] },
		{ value: true, expectedCodes: [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD], expectedPaths: ["$"] },
		{ value: {}, expectedCodes: [PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD], expectedPaths: ["$.version"] },
		{
			value: { version: PROJECT_MAP_SCHEMA_V1, project: "x", capabilities: 3 },
			expectedCodes: [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD],
			expectedPaths: ["$.project", "$.capabilities"],
		},
	];
	for (const { value, expectedCodes, expectedPaths } of cases) {
		const result = validateProjectMap(value);
		assert.equal(result.map, null);
		assert.deepEqual(codes(result), expectedCodes);
		assert.deepEqual(paths(result), expectedPaths);
		assert.ok(result.diagnostics.every((diagnostic) => diagnostic.severity === "error"));
	}
});

test("parses JSON text and reports invalid JSON as a diagnostic", () => {
	const parsed = parseProjectMap(JSON.stringify(minimalMap()));
	assert.deepEqual(parsed.diagnostics, []);
	assert.equal(parsed.map?.project.name, "Example Shop");

	const invalid = parseProjectMap("{ not json");
	assert.equal(invalid.map, null);
	assert.deepEqual(codes(invalid), [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_JSON]);
	assert.deepEqual(paths(invalid), ["$"]);
});

test("reports unknown references with exact paths", () => {
	const valid = validateProjectMap(
		minimalMap({
			foundations: [{ id: "repo-and-envs", outcome: "Repositories exist.", state: "done" }],
			capabilities: [
				{
					id: "merchant-catalog",
					outcome: "Merchants can publish and manage their catalog.",
					surfaces: ["web"],
					state: "active",
					foundationRefs: ["repo-and-envs"],
				},
				{
					id: "checkout",
					outcome: "Checkout works.",
					surfaces: ["web"],
					state: "planned",
					dependsOn: ["merchant-catalog"],
				},
			],
		}),
	);
	assert.deepEqual(valid.diagnostics, []);

	const result = validateProjectMap(
		minimalMap({
			capabilities: [
				{
					id: "checkout",
					outcome: "Checkout works.",
					surfaces: ["web"],
					state: "planned",
					foundationRefs: ["missing-foundation"],
					dependsOn: ["missing-capability"],
				},
			],
		}),
	);
	assert.equal(result.map, null);
	assert.deepEqual(codes(result), [
		PROJECT_MAP_DIAGNOSTIC_CODES.UNKNOWN_REFERENCE,
		PROJECT_MAP_DIAGNOSTIC_CODES.UNKNOWN_REFERENCE,
	]);
	assert.deepEqual(paths(result), ["$.capabilities[0].foundationRefs[0]", "$.capabilities[0].dependsOn[0]"]);
});

test("preserves original reference indices after duplicate entries", () => {
	const result = validateProjectMap(
		minimalMap({
			capabilities: [{ id: "checkout", outcome: "Checkout works.", surfaces: ["web"], state: "planned", dependsOn: ["ghost", "ghost", "missing"] }],
		}),
	);
	assert.deepEqual(codes(result), [
		PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD,
		PROJECT_MAP_DIAGNOSTIC_CODES.UNKNOWN_REFERENCE,
		PROJECT_MAP_DIAGNOSTIC_CODES.UNKNOWN_REFERENCE,
	]);
	assert.deepEqual(paths(result), ["$.capabilities[0].dependsOn[1]", "$.capabilities[0].dependsOn[0]", "$.capabilities[0].dependsOn[2]"]);
});

test("detects dependency cycles and reports each cyclic group once", () => {
	const pair = validateProjectMap(
		minimalMap({
			capabilities: [
				{ id: "alpha", outcome: "Alpha works.", surfaces: ["web"], state: "planned", dependsOn: ["beta"] },
				{ id: "beta", outcome: "Beta works.", surfaces: ["web"], state: "planned", dependsOn: ["alpha"] },
			],
		}),
	);
	assert.equal(pair.map, null);
	assert.deepEqual(codes(pair), [PROJECT_MAP_DIAGNOSTIC_CODES.DEPENDENCY_CYCLE]);
	assert.equal(pair.diagnostics[0].path, "$.capabilities[1].dependsOn[0]");
	assert.match(pair.diagnostics[0].message, /alpha[\s\S]*beta/);

	const self = validateProjectMap(
		minimalMap({
			capabilities: [{ id: "alpha", outcome: "Alpha works.", surfaces: ["web"], state: "planned", dependsOn: ["alpha"] }],
		}),
	);
	assert.deepEqual(codes(self), [PROJECT_MAP_DIAGNOSTIC_CODES.DEPENDENCY_CYCLE]);
	assert.equal(self.diagnostics[0].path, "$.capabilities[0].dependsOn[0]");
	assert.match(self.diagnostics[0].message, /alpha/);

	const triple = validateProjectMap(
		minimalMap({
			capabilities: [
				{ id: "alpha", outcome: "Alpha works.", surfaces: ["web"], state: "planned", dependsOn: ["beta"] },
				{ id: "beta", outcome: "Beta works.", surfaces: ["web"], state: "planned", dependsOn: ["gamma"] },
				{ id: "gamma", outcome: "Gamma works.", surfaces: ["web"], state: "planned", dependsOn: ["alpha"] },
			],
		}),
	);
	assert.deepEqual(codes(triple), [PROJECT_MAP_DIAGNOSTIC_CODES.DEPENDENCY_CYCLE]);
	assert.equal(triple.diagnostics[0].path, "$.capabilities[2].dependsOn[0]");

	const overlapping = validateProjectMap(
		minimalMap({
			capabilities: [
				{ id: "alpha", outcome: "Alpha works.", surfaces: ["web"], state: "planned", dependsOn: ["beta", "gamma"] },
				{ id: "beta", outcome: "Beta works.", surfaces: ["web"], state: "planned", dependsOn: ["gamma"] },
				{ id: "gamma", outcome: "Gamma works.", surfaces: ["web"], state: "planned", dependsOn: ["alpha"] },
			],
		}),
	);
	assert.deepEqual(codes(overlapping), [PROJECT_MAP_DIAGNOSTIC_CODES.DEPENDENCY_CYCLE]);
	assert.match(overlapping.diagnostics[0].message, /alpha[\s\S]*beta[\s\S]*gamma/);

	const acyclic = validateProjectMap(
		minimalMap({
			capabilities: [
				{ id: "alpha", outcome: "Alpha works.", surfaces: ["web"], state: "planned", dependsOn: ["beta", "gamma"] },
				{ id: "beta", outcome: "Beta works.", surfaces: ["web"], state: "planned", dependsOn: ["delta"] },
				{ id: "gamma", outcome: "Gamma works.", surfaces: ["web"], state: "planned", dependsOn: ["delta"] },
				{ id: "delta", outcome: "Delta works.", surfaces: ["web"], state: "planned" },
			],
		}),
	);
	assert.deepEqual(acyclic.diagnostics, []);
	assert.ok(acyclic.map);
});

test("reports exactly one diagnostic for a dependency group with several cycles", () => {
	const result = validateProjectMap(
		minimalMap({
			capabilities: [
				{ id: "alpha", outcome: "Alpha works.", surfaces: ["web"], state: "planned", dependsOn: ["beta", "gamma"] },
				{ id: "beta", outcome: "Beta works.", surfaces: ["web"], state: "planned", dependsOn: ["alpha"] },
				{ id: "gamma", outcome: "Gamma works.", surfaces: ["web"], state: "planned", dependsOn: ["alpha"] },
			],
		}),
	);
	assert.equal(result.map, null);
	assert.deepEqual(codes(result), [PROJECT_MAP_DIAGNOSTIC_CODES.DEPENDENCY_CYCLE]);
	assert.match(result.diagnostics[0].message, /alpha[\s\S]*beta[\s\S]*gamma/);
	assert.match(result.diagnostics[0].path, /^\$\.capabilities\[\d+\]\.dependsOn\[\d+\]$/);
});

test("reports separate diagnostics for disjoint dependency groups", () => {
	const result = validateProjectMap(
		minimalMap({
			capabilities: [
				{ id: "alpha", outcome: "Alpha works.", surfaces: ["web"], state: "planned", dependsOn: ["beta"] },
				{ id: "beta", outcome: "Beta works.", surfaces: ["web"], state: "planned", dependsOn: ["alpha"] },
				{ id: "gamma", outcome: "Gamma works.", surfaces: ["web"], state: "planned", dependsOn: ["delta"] },
				{ id: "delta", outcome: "Delta works.", surfaces: ["web"], state: "planned", dependsOn: ["gamma"] },
			],
		}),
	);
	assert.equal(result.map, null);
	assert.deepEqual(codes(result), [PROJECT_MAP_DIAGNOSTIC_CODES.DEPENDENCY_CYCLE, PROJECT_MAP_DIAGNOSTIC_CODES.DEPENDENCY_CYCLE]);
	assert.match(result.diagnostics[0].message, /alpha[\s\S]*beta/);
	assert.doesNotMatch(result.diagnostics[0].message, /gamma|delta/);
	assert.match(result.diagnostics[1].message, /delta[\s\S]*gamma|gamma[\s\S]*delta/);
	assert.doesNotMatch(result.diagnostics[1].message, /alpha|beta/);
});

test("rejects unsafe feature-document paths without filesystem access", () => {
	const result = validateProjectMap(
		minimalMap({
			capabilities: [
				{
					id: "merchant-catalog",
					outcome: "Merchants can publish and manage their catalog.",
					surfaces: ["web"],
					state: "active",
					featureDocs: ["odd/tasks/merchant-catalog.md", "/etc/passwd", "../secrets.md"],
				},
			],
		}),
	);
	assert.equal(result.map, null);
	assert.deepEqual(codes(result), [
		PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD,
		PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD,
	]);
	assert.deepEqual(paths(result), ["$.capabilities[0].featureDocs[1]", "$.capabilities[0].featureDocs[2]"]);
});

test("rejects Windows UNC and rooted feature-document paths", () => {
	const result = validateProjectMap(
		minimalMap({
			capabilities: [
				{
					id: "merchant-catalog",
					outcome: "Merchants can publish and manage their catalog.",
					surfaces: ["web"],
					state: "active",
					featureDocs: ["\\\\server\\share\\doc.md", "\\rooted\\doc.md"],
				},
			],
		}),
	);
	assert.deepEqual(codes(result), [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(result), ["$.capabilities[0].featureDocs[0]", "$.capabilities[0].featureDocs[1]"]);
});

test("rejects Windows drive-relative feature-document paths", () => {
	const result = validateProjectMap(
		minimalMap({
			capabilities: [
				{
					id: "merchant-catalog",
					outcome: "Merchants can publish and manage their catalog.",
					surfaces: ["web"],
					state: "active",
					featureDocs: ["odd/tasks/ok.md", "C:doc.md", "c:relative.md"],
				},
			],
		}),
	);
	assert.equal(result.map, null);
	assert.deepEqual(codes(result), [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(result), ["$.capabilities[0].featureDocs[1]", "$.capabilities[0].featureDocs[2]"]);
});

test("preserves feature-document indices after duplicate entries", () => {
	const result = validateProjectMap(
		minimalMap({
			capabilities: [
				{
					id: "merchant-catalog",
					outcome: "Merchants can publish and manage their catalog.",
					surfaces: ["web"],
					state: "active",
					featureDocs: ["odd/tasks/ok.md", "odd/tasks/ok.md", "odd/tasks/missing.md"],
				},
			],
		}),
		{ featureDocExists: (candidate) => candidate !== "odd/tasks/missing.md" },
	);
	assert.equal(result.map, null);
	assert.deepEqual(codes(result), [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FEATURE_DOCUMENT]);
	assert.deepEqual(paths(result), ["$.capabilities[0].featureDocs[1]", "$.capabilities[0].featureDocs[2]"]);
});

test("treats a missing feature document as an error in strict mode and a warning in tolerant mode", () => {
	const strict = validateProjectMap(
		minimalMap({
			capabilities: [
				{
					id: "merchant-catalog",
					outcome: "Merchants can publish and manage their catalog.",
					surfaces: ["web"],
					state: "active",
					featureDocs: ["odd/tasks/absent.md"],
				},
			],
		}),
		{ featureDocExists: () => false },
	);
	assert.equal(strict.map, null);
	assert.deepEqual(codes(strict), [PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FEATURE_DOCUMENT]);
	assert.deepEqual(paths(strict), ["$.capabilities[0].featureDocs[0]"]);
	assert.equal(strict.diagnostics[0].severity, "error");

	const tolerant = validateProjectMap(
		minimalMap({
			capabilities: [
				{
					id: "merchant-catalog",
					outcome: "Merchants can publish and manage their catalog.",
					surfaces: ["web"],
					state: "active",
					featureDocs: ["odd/tasks/absent.md"],
				},
			],
		}),
		{ featureDocExists: () => false, strictFeatureDocs: false },
	);
	assert.ok(tolerant.map);
	assert.deepEqual(codes(tolerant), [PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FEATURE_DOCUMENT]);
	assert.equal(tolerant.diagnostics[0].severity, "warning");

	const resolved = validateProjectMap(
		minimalMap({
			capabilities: [
				{
					id: "merchant-catalog",
					outcome: "Merchants can publish and manage their catalog.",
					surfaces: ["web"],
					state: "active",
					featureDocs: ["odd/tasks/present.md"],
				},
			],
		}),
		{ featureDocExists: (candidate: string) => candidate === "odd/tasks/present.md" },
	);
	assert.deepEqual(resolved.diagnostics, []);
	assert.ok(resolved.map);
});

test("reads the artifact from disk and reports unreadable paths as diagnostics", () => {
	const directory = mkdtempSync(join(tmpdir(), "project-map-"));
	try {
		const validPath = join(directory, "project-map.json");
		writeFileSync(validPath, JSON.stringify(minimalMap(), null, 2), "utf8");
		const valid = readProjectMapFile(validPath);
		assert.deepEqual(valid.diagnostics, []);
		assert.equal(valid.map?.project.id, "example-shop");

		const invalidPath = join(directory, "broken.json");
		writeFileSync(invalidPath, "{ not json", "utf8");
		const invalid = readProjectMapFile(invalidPath);
		assert.equal(invalid.map, null);
		assert.deepEqual(codes(invalid), [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_JSON]);
		assert.deepEqual(paths(invalid), ["$"]);

		const missing = readProjectMapFile(join(directory, "absent.json"));
		assert.equal(missing.map, null);
		assert.deepEqual(codes(missing), [PROJECT_MAP_DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT]);
		assert.deepEqual(paths(missing), ["$"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

function approvedMap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return minimalMap({
		approval: { state: "approved", approvedAt: "2026-09-23T12:00:00Z", approvedBy: "facundo" },
		...overrides,
	});
}

test("exports the approval vocabulary and the artifact path", () => {
	assert.deepEqual([...PROJECT_MAP_APPROVAL_STATES], ["draft", "approved"]);
	assert.equal(PROJECT_MAP_ARTIFACT_PATH, "openspec/project-map.json");
});

test("defaults a missing approval block to draft", () => {
	const result = validateProjectMap(minimalMap());
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.map?.approval, { state: "draft" });
});

test("accepts an approved map carrying both audit fields", () => {
	const result = validateProjectMap(approvedMap());
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.map?.approval, { state: "approved", approvedAt: "2026-09-23T12:00:00Z", approvedBy: "facundo" });
});

test("requires both audit fields on an approved map", () => {
	const result = validateProjectMap(minimalMap({ approval: { state: "approved" } }));
	assert.equal(result.map, null);
	assert.deepEqual(codes(result), [PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD, PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD]);
	assert.deepEqual(paths(result), ["$.approval.approvedAt", "$.approval.approvedBy"]);
});

test("rejects an approved map whose audit fields are unusable", () => {
	const result = validateProjectMap(minimalMap({ approval: { state: "approved", approvedAt: "yesterday", approvedBy: "   " } }));
	assert.equal(result.map, null);
	assert.deepEqual(codes(result), [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(result), ["$.approval.approvedAt", "$.approval.approvedBy"]);
});

test("rejects a draft that carries approval audit fields", () => {
	const result = validateProjectMap(minimalMap({ approval: { state: "draft", approvedAt: "2026-09-23T12:00:00Z", approvedBy: "facundo" } }));
	assert.equal(result.map, null);
	assert.deepEqual(codes(result), [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(result), ["$.approval.approvedAt", "$.approval.approvedBy"]);
});

test("rejects an unknown or malformed approval block", () => {
	const unknownState = validateProjectMap(minimalMap({ approval: { state: "pending" } }));
	assert.equal(unknownState.map, null);
	assert.deepEqual(codes(unknownState), [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(unknownState), ["$.approval.state"]);

	const missingState = validateProjectMap(minimalMap({ approval: {} }));
	assert.equal(missingState.map, null);
	assert.deepEqual(codes(missingState), [PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD]);
	assert.deepEqual(paths(missingState), ["$.approval.state"]);

	const notAnObject = validateProjectMap(minimalMap({ approval: "approved" }));
	assert.equal(notAnObject.map, null);
	assert.deepEqual(codes(notAnObject), [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(notAnObject), ["$.approval"]);
});

test("rejects unknown and runtime coordination fields inside the approval block", () => {
	const result = validateProjectMap(minimalMap({ approval: { state: "draft", approvedOn: "x", lease: "y" } }));
	assert.equal(result.map, null);
	assert.deepEqual(codes(result), [PROJECT_MAP_DIAGNOSTIC_CODES.FORBIDDEN_RUNTIME_FIELD, PROJECT_MAP_DIAGNOSTIC_CODES.UNKNOWN_FIELD]);
	assert.deepEqual(paths(result), ["$.approval.lease", "$.approval.approvedOn"]);
});

test("allows an empty surface list while the map is a draft", () => {
	const draft = minimalMap({ capabilities: [{ id: "shopping-cart", outcome: "Shoppers can build a cart.", surfaces: [], state: "planned" }] });
	const result = validateProjectMap(draft);
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.map?.capabilities[0].surfaces, []);
});

test("requires a non-empty surface list once the map is approved", () => {
	const result = validateProjectMap(approvedMap({ capabilities: [{ id: "shopping-cart", outcome: "Shoppers can build a cart.", surfaces: [], state: "planned" }] }));
	assert.equal(result.map, null);
	assert.deepEqual(codes(result), [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD]);
	assert.deepEqual(paths(result), ["$.capabilities[0].surfaces"]);
});

test("still requires the surfaces field on a draft capability", () => {
	const result = validateProjectMap(minimalMap({ capabilities: [{ id: "shopping-cart", outcome: "Shoppers can build a cart.", state: "planned" }] }));
	assert.equal(result.map, null);
	assert.deepEqual(codes(result), [PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD]);
	assert.deepEqual(paths(result), ["$.capabilities[0].surfaces"]);
});

test("canonicalizes approval between project and foundations", () => {
	const result = validateProjectMap(approvedMap());
	assert.ok(result.map);
	const parsed = JSON.parse(serializeProjectMap(result.map)) as Record<string, unknown>;
	assert.deepEqual(Object.keys(parsed), ["version", "project", "approval", "foundations", "capabilities"]);
	assert.deepEqual(Object.keys(parsed.approval as Record<string, unknown>), ["state", "approvedAt", "approvedBy"]);
});

test("keeps serialization stable and round-trippable for approved maps", () => {
	const result = validateProjectMap(approvedMap());
	assert.ok(result.map);
	const once = serializeProjectMap(result.map);
	assert.equal(serializeProjectMap(result.map), once);
	assert.deepEqual(canonicalizeProjectMap(canonicalizeProjectMap(result.map)), canonicalizeProjectMap(result.map));
	const reparsed = parseProjectMap(once);
	assert.deepEqual(reparsed.diagnostics, []);
	assert.deepEqual(reparsed.map, canonicalizeProjectMap(result.map));
});

test("defaults a draft when the artifact omits approval entirely", () => {
	const directory = mkdtempSync(join(tmpdir(), "project-map-approval-"));
	try {
		const artifactPath = join(directory, "project-map.json");
		writeFileSync(artifactPath, JSON.stringify(minimalMap(), null, 2), "utf8");
		const read = readProjectMapFile(artifactPath);
		assert.deepEqual(read.diagnostics, []);
		assert.equal(read.map?.approval.state, "draft");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("rejects an ISO instant that is not a real calendar moment", () => {
	for (const approvedAt of ["2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-32T00:00:00Z", "2026-09-23T25:00:00Z", "2026-09-23T00:60:00Z", "2026-09-23T00:00:61Z"]) {
		const result = validateProjectMap(approvedMap({ approval: { state: "approved", approvedAt, approvedBy: "facundo" } }));
		assert.equal(result.map, null, `expected ${approvedAt} to be rejected`);
		assert.deepEqual(codes(result), [PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD]);
		assert.deepEqual(paths(result), ["$.approval.approvedAt"]);
	}
	const real = validateProjectMap(approvedMap({ approval: { state: "approved", approvedAt: "2026-02-28T23:59:59Z", approvedBy: "facundo" } }));
	assert.deepEqual(real.diagnostics, []);
	const leap = validateProjectMap(approvedMap({ approval: { state: "approved", approvedAt: "2028-02-29T00:00:00Z", approvedBy: "facundo" } }));
	assert.deepEqual(leap.diagnostics, []);
});

test("exports the feature-document path predicate the draft generator reuses", () => {
	assert.equal(isSafeFeatureDocumentPath("odd/tasks/roadmap.md"), true);
	for (const unsafe of ["/absolute.md", "C:drive.md", "../outside.md", "odd/../../outside.md", "\\\\unc\\share.md", "\\rooted.md"]) {
		assert.equal(isSafeFeatureDocumentPath(unsafe), false, `expected ${unsafe} to be unsafe`);
	}
});

test("accepts ISO instants whose year is below 100", () => {
	// Date.UTC maps years 0-99 onto 1900-1999, so a Date round-trip would reject these.
	for (const approvedAt of ["0050-01-01T00:00:00Z", "0001-12-31T23:59:59Z", "0099-02-28T00:00:00Z"]) {
		const result = validateProjectMap(approvedMap({ approval: { state: "approved", approvedAt, approvedBy: "facundo" } }));
		assert.deepEqual(result.diagnostics, [], `expected ${approvedAt} to be accepted`);
	}
	// The calendar check still rejects a real overflow in the same range.
	const overflow = validateProjectMap(approvedMap({ approval: { state: "approved", approvedAt: "0050-02-30T00:00:00Z", approvedBy: "facundo" } }));
	assert.equal(overflow.map, null);
	assert.deepEqual(paths(overflow), ["$.approval.approvedAt"]);
});
