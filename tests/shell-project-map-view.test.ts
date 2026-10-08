import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PROJECT_MAP_ARTIFACT_PATH,
	PROJECT_MAP_SCHEMA_V1,
	type ProjectMapV1,
} from "../lib/shell-project-map-schema.ts";
import {
	PROJECT_MAP_EXPANDED,
	PROJECT_MAP_HELP_MARKER,
	PROJECT_MAP_OVERLAY_UNAVAILABLE,
	PROJECT_MAP_STATE_GLYPH,
	projectMapCardBody,
	projectMapCardDescriptor,
	projectMapCardDigest,
	projectMapCardState,
	projectMapCoverage,
	projectMapCoverageLines,
	projectMapGroupFromHeader,
	projectMapStaticBlockers,
	projectMapSummaryLine,
	toggleProjectMapGroup,
	type ProjectMapCardState,
} from "../lib/shell-project-map-view.ts";

function map(overrides: Partial<ProjectMapV1> = {}): ProjectMapV1 {
	return {
		version: PROJECT_MAP_SCHEMA_V1,
		project: { id: "example-shop", name: "Example Shop" },
		approval: { state: "draft" },
		foundations: [{ id: "repository-tooling", outcome: "Tooling is declared.", state: "done", evidence: ["package.json"] }],
		capabilities: [
			{ id: "merchant-catalog", outcome: "Merchants manage a catalog.", foundationRefs: [], dependsOn: [], contracts: [], featureDocs: [], surfaces: ["web", "api"], state: "done" },
			{ id: "shopping-cart", outcome: "Shoppers build a cart.", foundationRefs: [], dependsOn: [], contracts: [], featureDocs: [], surfaces: [], state: "planned" },
			{ id: "checkout", outcome: "Shoppers check out.", foundationRefs: [], dependsOn: [], contracts: [], featureDocs: [], surfaces: ["web"], state: "blocked" },
		],
		...overrides,
	};
}

function ready(state: ProjectMapV1) {
	return {
		kind: "ready",
		path: PROJECT_MAP_ARTIFACT_PATH,
		map: state,
		coverage: projectMapCoverage(state),
		overlay: PROJECT_MAP_OVERLAY_UNAVAILABLE,
	} as const;
}

function withArtifact(text: string | null, run: (path: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "project-map-view-"));
	try {
		const path = join(directory, "project-map.json");
		if (text !== null) writeFileSync(path, text, "utf8");
		run(path);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("capability rows use Todo theme roles without changing marker geometry", () => {
	const painted: Array<{ role: string; text: string }> = [];
	const paint = (role: string, text: string) => { painted.push({ role, text }); return text; };
	const body = projectMapCardBody(ready(map()), PROJECT_MAP_EXPANDED, "merchant-catalog", 120, paint);
	assert.deepEqual(painted.filter(({ text }) => ["✓", "Merchants manage a catalog.", "○", "Shoppers build a cart."].includes(text)), [
		{ role: "success", text: "✓" },
		{ role: "dim", text: "Merchants manage a catalog." },
		{ role: "muted", text: "○" },
		{ role: "text", text: "Shoppers build a cart." },
	]);
	assert.ok(painted.some(({ role, text }) => role === "muted" && text === "?"));
	assert.equal(body.lines[3], "▸ ? ✓ Merchants manage a catalog.");
	assert.deepEqual(body.capabilities[0], { line: 3, id: "merchant-catalog", height: 1, help: 2 });
});

test("long capability lists fold done rows and cap open rows exactly like Todos", () => {
	const capabilities = Array.from({ length: 40 }, (_, index) => ({ ...map().capabilities[0]!, id: `row-${index}`, outcome: `Row ${index}`, state: index < 25 ? "done" as const : index === 25 ? "active" as const : "planned" as const }));
	const painted: Array<{ role: string; text: string }> = [];
	const paint = (role: string, text: string) => { painted.push({ role, text }); return text; };
	const body = projectMapCardBody(ready(map({ capabilities })), PROJECT_MAP_EXPANDED, "row-25", 80, paint);
	assert.deepEqual({ count: body.lines.length, summary: body.lines[3], firstOpen: body.lines[4], more: body.lines.at(-1) }, {
		count: 15, summary: "  ✓ 25 done", firstOpen: "▸ ? ◉ Row 25", more: "  … 5 more",
	}, "foundation header and row, capability header, twelve capability body rows");
	assert.deepEqual(body.capabilities.map(({ id }) => id), capabilities.slice(25, 35).map(({ id }) => id));
	assert.equal(body.selected, 4);
	assert.ok(painted.some(({ role, text }) => role === "muted" && text === "25 done"));
	assert.ok(painted.some(({ role, text }) => role === "muted" && text === "… 5 more"));
	assert.ok(painted.some(({ role, text }) => role === "accent" && text === "◉"));
	assert.ok(painted.some(({ role, text }) => role === "accent" && text === "Row 25"));
});

test("folding boundaries retain twelve rows, cap all-open lists, and collapse all-done lists", () => {
	const capabilities = Array.from({ length: 13 }, (_, index) => ({ ...map().capabilities[0]!, id: `row-${index}`, outcome: `Row ${index}`, state: "planned" as const }));
	const atCap = projectMapCardBody(ready(map({ foundations: [], capabilities: capabilities.slice(0, 12) })));
	assert.equal(atCap.lines.length, 13);
	assert.equal(atCap.capabilities.length, 12);
	const overCap = projectMapCardBody(ready(map({ foundations: [], capabilities })));
	assert.equal(overCap.lines.length, 13);
	assert.equal(overCap.capabilities.length, 11);
	assert.equal(overCap.lines.at(-1), "  … 2 more");
	const allDone = projectMapCardBody(ready(map({ foundations: [], capabilities: capabilities.map((row) => ({ ...row, state: "done" })) })), PROJECT_MAP_EXPANDED, "row-0");
	assert.deepEqual(allDone.lines, ["▾ Product capabilities 13/13", "  ✓ 13 done"]);
	assert.deepEqual(allDone.capabilities, []);
	assert.equal(allDone.selected, undefined);
	const mixed = capabilities.map((row, index) => index === 0 ? { ...row, state: "done" as const } : row);
	const folded = projectMapCardBody(ready(map({ capabilities: mixed })));
	assert.equal(folded.lines.at(-1), "  … 2 more");
	assert.equal(folded.capabilities.length, 10);
	const noOverflow = projectMapCardBody(ready(map({ capabilities: mixed.map((row, index) => index < 2 ? { ...row, state: "done" as const } : row) })));
	assert.equal(noOverflow.capabilities.length, 11);
	assert.equal(noOverflow.lines.some((line) => line.includes("more")), false);
	const foundations = Array.from({ length: 13 }, (_, index) => ({ ...map().foundations[0]!, id: `foundation-${index}` }));
	assert.equal(projectMapCardBody(ready(map({ foundations, capabilities: [] }))).lines.length, 15, "foundations are never capped");
});

test("publishes a glyph for every frozen state", () => {
	assert.deepEqual(Object.keys(PROJECT_MAP_STATE_GLYPH).sort(), ["active", "blocked", "done", "planned", "ready", "review"]);
	assert.equal(PROJECT_MAP_STATE_GLYPH.done, "✓");
	assert.equal(PROJECT_MAP_STATE_GLYPH.blocked, "✕");
});

test("classifies a missing artifact as empty", () => {
	withArtifact(null, (path) => {
		const state = projectMapCardState(path, PROJECT_MAP_OVERLAY_UNAVAILABLE);
		assert.equal(state.kind, "empty");
		const descriptor = projectMapCardDescriptor(state);
		assert.equal(descriptor.tone, "info");
		assert.equal(descriptor.title, "Project Map");
		assert.equal(descriptor.subtitle, "");
		assert.deepEqual(descriptor.body, []);
		assert.deepEqual(projectMapCardBody(state), { lines: [], headers: [], capabilities: [] });
		assert.doesNotMatch(JSON.stringify(descriptor), /\/gentle:/);
	});
});

test("classifies an invalid artifact as invalid and shows the diagnostic path", () => {
	withArtifact(JSON.stringify({ version: PROJECT_MAP_SCHEMA_V1, project: { id: "example-shop", name: "" }, capabilities: [] }), (path) => {
		const state = projectMapCardState(path, PROJECT_MAP_OVERLAY_UNAVAILABLE);
		assert.equal(state.kind, "invalid");
		const descriptor = projectMapCardDescriptor(state);
		assert.equal(descriptor.tone, "error");
		assert.ok(descriptor.body.join("\n").includes("$.project.name"), "expected the diagnostic path in the card");
	});
});

test("classifies malformed JSON as invalid and renders its diagnostic", () => {
	withArtifact("{", (path) => {
		const state = projectMapCardState(path, PROJECT_MAP_OVERLAY_UNAVAILABLE);
		assert.equal(state.kind, "invalid");
		const diagnostics = (state as { diagnostics?: Array<{ code: string; message: string }> }).diagnostics;
		assert.ok(diagnostics?.some((diagnostic) => diagnostic.code === "project-map/invalid-json"));
		const descriptor = projectMapCardDescriptor(state);
		assert.equal(descriptor.tone, "error");
		assert.ok(descriptor.body.join("\n").includes(diagnostics?.[0]?.message ?? ""));
	});
});

test("caps invalid diagnostics at three without suggesting a command", () => {
	withArtifact(JSON.stringify({ version: PROJECT_MAP_SCHEMA_V1, claim: "session-42", x: true, project: { name: "" }, foundations: [], capabilities: [] }), (path) => {
		const state = projectMapCardState(path, PROJECT_MAP_OVERLAY_UNAVAILABLE);
		assert.equal(state.kind, "invalid");
		if (state.kind !== "invalid") return;
		assert.ok(state.diagnostics.length > 3, "the artifact produces more diagnostics than the card may render");
		const rendered = state.diagnostics.slice(0, 3).map((diagnostic) => `  ${diagnostic.path}: ${diagnostic.message}`);
		const fourth = `  ${state.diagnostics[3]!.path}: ${state.diagnostics[3]!.message}`;
		const descriptor = projectMapCardDescriptor(state);
		assert.deepEqual(descriptor.body.slice(1), rendered);
		assert.equal(descriptor.body.includes(fourth), false);
		assert.doesNotMatch(descriptor.body.join("\n"), /\/gentle:/);
	});
});

test("classifies a valid artifact as ready and carries the map", () => {
	withArtifact(`${JSON.stringify(map(), null, 2)}\n`, (path) => {
		const state = projectMapCardState(path, PROJECT_MAP_OVERLAY_UNAVAILABLE);
		assert.equal(state.kind, "ready");
		if (state.kind === "ready") assert.equal(state.map.project.id, "example-shop");
	});
});

test("renders capability progress in the subtitle independently of artifact approval", () => {
	const draft = projectMapCardDescriptor(ready(map()));
	assert.equal(draft.subtitle, "Example Shop · 1/3");
	assert.equal(draft.tone, "info");

	const approved = projectMapCardDescriptor(
		ready(map({ approval: { state: "approved", approvedAt: "2026-09-23T12:00:00Z", approvedBy: "facundo" } })),
	);
	assert.equal(approved.subtitle, draft.subtitle);
	assert.equal(approved.tone, "info");
	assert.equal(projectMapCardDescriptor({ ...ready(map()), derived: true }).subtitle, draft.subtitle);
	assert.equal(projectMapCardDescriptor(ready(map({ capabilities: [] }))).subtitle, "Example Shop · 0/0");
});

test("renders grouped rows with done indicators and lifecycle glyphs", () => {
	const descriptor = projectMapCardDescriptor(ready(map()));
	const body = descriptor.body.join("\n");
	assert.ok(body.includes("▾ Foundations 1/1"));
	assert.ok(body.includes("▾ Product capabilities 1/3"));
	assert.ok(body.includes(`✓ repository-tooling`));
	assert.ok(body.includes(`✓ Merchants manage a catalog.`));
	assert.ok(body.includes(`✕ Shoppers check out.`));
});

test("structured card body records group headers and the selected capability row", () => {
	const body = projectMapCardBody(ready(map()), PROJECT_MAP_EXPANDED, "checkout");
	assert.deepEqual(body.headers, [{ line: 0, group: "foundations" }, { line: 2, group: "capabilities" }]);
	assert.equal(body.selected, 5);
	assert.match(body.lines[body.selected!], /^▸ \? ✕ Shoppers check out\./, "selection replaces the indent while retaining the lifecycle glyph");
});

// A capability row is built as one body line rather than intentionally wrapped. A row that
// spilled onto a second line lost its glyph and its indent, so it read as two unrelated lines.
// The functional-point label is cut at its end instead, keeping the code and the beginning of the
// name, and the card keeps the identifier in its click metadata.
test("a capability row is one body line, end-truncates a long outcome, and keeps its markers", () => {
	const id = "repo-production";
	const outcome = `FP-1a — ${"Repo-side production path ".repeat(3)}(no accounts needed)`;
	const body = projectMapCardBody(ready(map({ capabilities: [{ ...map().capabilities[0]!, id, outcome }] })), PROJECT_MAP_EXPANDED, undefined, 46);
	const target = body.capabilities[0]!;
	assert.equal(target.height, 1, "the row is one body line");
	assert.equal(target.id, id, "the click target remains the identifier");
	const row = body.lines[target.line]!;
	assert.match(row, /^  \? ✓ /, "the row keeps its indent and marker columns");
	assert.equal(row.includes("· Web"), false, "the row has no surface tail");
	assert.ok(row.includes("…"), "a row that does not fit truncates its functional-point label");
	assert.ok(row.endsWith("…"), "the ellipsis lands at the end of the label, not inside it");
	assert.ok(row.includes("FP-1a — Repo-side"), "the code and the head of the name survive");
	assert.equal(row.includes("(no accounts needed)"), false, "the tail is what the ellipsis replaces");
	assert.ok(row.length <= 46, `${row.length} exceeds the body budget`);
});

test("a painted functional-point label keeps selection and click metadata addressed by id", () => {
	const id = "repo-production";
	const outcome = "FP-1a — Repo-side production path (no accounts needed)";
	const body = projectMapCardBody(ready(map({ capabilities: [{ ...map().capabilities[0]!, id, outcome }] })), PROJECT_MAP_EXPANDED, id, 80);
	const target = body.capabilities[0]!;
	assert.equal(target.id, id, "click metadata carries the identifier, not the painted label");
	assert.equal(body.selected, target.line, "selection matches the identifier");
	assert.equal(target.help, 2, "the help marker keeps its column");
	const row = body.lines[target.line]!;
	assert.match(row, /^▸ \? ✓ FP-1a — Repo-side production path \(no accounts needed\)$/);
	assert.equal(row.includes(id), false, "the identifier is not painted in place of the label");
});

test("collapses outcome whitespace so a hand-edited label cannot split a row", () => {
	const newlineId = "repo-production";
	const spacesId = "spaced-label";
	const body = projectMapCardBody(ready(map({
		capabilities: [
			{ ...map().capabilities[0]!, id: newlineId, outcome: "FP-1\nSecond line" },
			{ ...map().capabilities[1]!, id: spacesId, outcome: "Spaces   collapse\ttoo", surfaces: ["web"] },
		],
	})), PROJECT_MAP_EXPANDED, newlineId, 80);
	const newlineTarget = body.capabilities.find((entry) => entry.id === newlineId)!;
	const spacesTarget = body.capabilities.find((entry) => entry.id === spacesId)!;
	assert.equal(body.lines[newlineTarget.line], "▸ ? ✓ FP-1 Second line");
	assert.equal(body.lines[spacesTarget.line], "  ? ○ Spaces collapse too");
	assert.equal(body.lines[newlineTarget.line]!.includes("\n"), false, "a newline in the artifact stays inside one painted row");
	assert.equal(newlineTarget.id, newlineId, "click metadata remains addressed by id");
	assert.equal(spacesTarget.id, spacesId, "every collapsed label keeps its own id target");
});

test("a capability whose outcome is its id keeps its plain row text", () => {
	const capability = { ...map().capabilities[1]!, outcome: "shopping-cart" };
	const body = projectMapCardBody(ready(map({ capabilities: [capability] })), PROJECT_MAP_EXPANDED);
	assert.equal(body.lines[body.capabilities[0]!.line], "  ? ○ shopping-cart");
});

test("a capability row carries the marker left of its lifecycle glyph", () => {
	const body = projectMapCardBody(ready(map()), PROJECT_MAP_EXPANDED);
	const target = body.capabilities[0]!;
	const row = body.lines[target.line]!;
	assert.match(row, /^\s+\? [✓○✕◉◐] /, "the marker precedes the lifecycle glyph");
	assert.equal(target.help, row.indexOf(PROJECT_MAP_HELP_MARKER), "the recorded column is the one the row paints");
});

test("a capability that declares no surface ends at its label without an absence tail", () => {
	const body = projectMapCardBody(ready(map()));
	const target = body.capabilities.find((entry) => entry.id === "shopping-cart")!;
	assert.equal(body.lines[target.line], "  ? ○ Shoppers build a cart.");
});

test("static blockers name the state, the foundations and the dependencies that are not done", () => {
	const state = map({
		foundations: [{ id: "tooling", outcome: "Tooling", state: "planned", evidence: [] }],
		capabilities: [
			{ id: "catalog", outcome: "Catalog", foundationRefs: [], dependsOn: [], contracts: [], featureDocs: [], surfaces: ["web"], state: "planned" },
			{ id: "checkout", outcome: "Complete a purchase.", foundationRefs: ["tooling"], dependsOn: ["catalog"], contracts: [], featureDocs: [], surfaces: ["web"], state: "blocked" },
		],
	});
	assert.deepEqual(projectMapStaticBlockers(state, "checkout"), ["estado bloqueado", "fundamento tooling ○", "dependencia catalog ○"]);
	assert.deepEqual(projectMapStaticBlockers(state, "catalog"), [], "a planned capability with no references is not blocked");
	assert.deepEqual(projectMapStaticBlockers(state, "missing"), [], "a capability the map does not declare has no blockers");
});

test("static blockers skip references the map does not declare", () => {
	const state = map({ capabilities: [{ id: "checkout", outcome: "Checkout", foundationRefs: ["missing"], dependsOn: ["gone"], contracts: [], featureDocs: [], surfaces: ["web"], state: "planned" }] });
	assert.deepEqual(projectMapStaticBlockers(state, "checkout"), []);
});

test("the selection adds no Inspector and still moves the descriptor", () => {
	const base = ready(map());
	assert.notEqual(projectMapCardDigest(base, PROJECT_MAP_EXPANDED, "checkout"), projectMapCardDigest(base), "selection moves the descriptor");
	assert.equal(projectMapCardDescriptor(base, PROJECT_MAP_EXPANDED, "checkout").body.some((line) => line.includes("Inspector")), false, "and the Inspector is gone");
});

test("collapsing one group preserves the other group and its header", () => {
	const state = ready(map());
	const collapsed = toggleProjectMapGroup(PROJECT_MAP_EXPANDED, "foundations");
	assert.deepEqual(collapsed, { foundations: true, capabilities: false });
	const body = projectMapCardDescriptor(state, collapsed).body.join("\n");
	assert.ok(body.includes("▸ Foundations 1/1"));
	assert.equal(body.includes("repository-tooling"), false);
	assert.ok(body.includes("▾ Product capabilities 1/3"));
	assert.ok(body.includes("Merchants manage a catalog."));
	assert.deepEqual(toggleProjectMapGroup(collapsed, "capabilities"), { foundations: true, capabilities: true });
});

test("omits the foundations group when no foundation is declared", () => {
	const body = projectMapCardDescriptor(ready(map({ foundations: [] }))).body.join("\n");
	assert.equal(body.includes("Foundations"), false);
	assert.ok(body.includes("▾ Product capabilities 1/3"));
});

test("reads a rendered group header back to its group and rejects content rows", () => {
	assert.equal(projectMapGroupFromHeader("│ ▾ Foundations 1/1            │"), "foundations");
	assert.equal(projectMapGroupFromHeader("│ ▸ Product capabilities 2/3  │"), "capabilities");
	assert.equal(projectMapGroupFromHeader("  ✓ repository-tooling"), undefined);
	assert.equal(projectMapGroupFromHeader("│ ✿ Project Map Example Shop · draft │"), undefined);
	assert.equal(projectMapGroupFromHeader("│ ▾ Foundations"), undefined);
});

test("a card with both groups collapsed contains only their headers", () => {
	assert.deepEqual(projectMapCardDescriptor(ready(map()), { foundations: true, capabilities: true }).body, [
		"▸ Foundations 1/1", "▸ Product capabilities 1/3",
	]);
});

test("computes coverage from declared capabilities and counts only done ones", () => {
	const coverage = projectMapCoverage(map());
	const web = coverage.find((entry) => entry.surface === "web");
	assert.deepEqual(web, { surface: "web", declared: 2, done: 1 });
	const api = coverage.find((entry) => entry.surface === "api");
	assert.deepEqual(api, { surface: "api", declared: 1, done: 1 });
	const security = coverage.find((entry) => entry.surface === "security");
	assert.deepEqual(security, { surface: "security", declared: 0, done: 0 });
});

test("builds unpacked map coverage lines in schema order from the supplied counts", () => {
	const state = map();
	const coverage = projectMapCoverage(state);
	assert.deepEqual(projectMapCoverageLines(state, [...coverage].reverse()), [
		"Product/UX —",
		"Web 50% (1/2): merchant-catalog ✓, checkout ✕",
		"API 100% (1/1): merchant-catalog ✓",
		"Data —",
		"Security —",
		"Ops —",
		"Tests —",
	]);
	const thirds = coverage.map((entry) => entry.surface === "web" ? { ...entry, done: 2, declared: 3 } : entry);
	assert.equal(projectMapCoverageLines(state, thirds)[1], "Web 67% (2/3): merchant-catalog ✓, checkout ✕", "the builder formats supplied coverage, not a second derivation");
	const empty = map({ capabilities: [] });
	assert.deepEqual(projectMapCoverageLines(empty, projectMapCoverage(empty)), ["Product/UX —", "Web —", "API —", "Data —", "Security —", "Ops —", "Tests —"]);
});

test("the card paints only its groups and label-only rows, preserving row targets", () => {
	const body = projectMapCardBody(ready(map()), PROJECT_MAP_EXPANDED, "merchant-catalog", 120);
	assert.deepEqual(body.lines, [
		"▾ Foundations 1/1", "  ✓ repository-tooling", "▾ Product capabilities 1/3",
		"▸ ? ✓ Merchants manage a catalog.", "  ? ○ Shoppers build a cart.", "  ? ✕ Shoppers check out.",
	]);
	assert.deepEqual(body.capabilities, [{ line: 3, id: "merchant-catalog", height: 1, help: 2 }, { line: 4, id: "shopping-cart", height: 1, help: 2 }, { line: 5, id: "checkout", height: 1, help: 2 }]);
	assert.equal(body.selected, 3);
});

test("renders an undeclared surface as unknown and never as zero percent", () => {
	const state = map();
	const coverageLine = projectMapCoverageLines(state, projectMapCoverage(state)).find((line) => line.includes("Security"));
	assert.ok(coverageLine, "expected a coverage line naming Security");
	assert.ok(coverageLine.includes("Security —"), `expected an unknown marker, got ${coverageLine}`);
	assert.equal(coverageLine.includes("Security 0%"), false);
});

test("renders a declared surface with its share, counts, and declaring capabilities", () => {
	const state = map();
	const body = projectMapCoverageLines(state, projectMapCoverage(state)).join("\n");
	assert.ok(body.includes("Web 50% (1/2):"), `expected the Web explanation, got ${body}`);
	assert.ok(body.includes("merchant-catalog ✓"), `expected the done declaring capability, got ${body}`);
	assert.ok(body.includes("checkout ✕"), `expected the blocked declaring capability, got ${body}`);
	assert.ok(body.includes("API 100% (1/1): merchant-catalog ✓"), `expected the API explanation, got ${body}`);
	assert.equal(body.includes("Merchants manage a catalog. ✓"), false, "Coverage remains an identifier roll-up");
});

test("reports every surface of the frozen vocabulary exactly once", () => {
	const coverage = projectMapCoverage(map());
	assert.deepEqual(
		coverage.map((entry) => entry.surface),
		["productUx", "web", "api", "data", "security", "operations", "tests"],
	);
});

test("folds every painted label into the digest, even past the default row budget", () => {
	const first = `${"A".repeat(30)}FIRST${"Z".repeat(30)}`;
	const other = `${"A".repeat(30)}OTHER${"Z".repeat(30)}`;
	const state = (outcome: string) => ready(map({ capabilities: [{ ...map().capabilities[0]!, outcome }] }));
	assert.notEqual(projectMapCardDigest(state(first)), projectMapCardDigest(state(other)), "a wider card must not reuse a stale label frame");
	const collapsed = state("Same   painted label");
	const equivalent = state("Same\npainted\tlabel");
	assert.deepEqual(projectMapCardDescriptor(collapsed), projectMapCardDescriptor(equivalent), "the two states render identically after paint-time whitespace collapse");
	assert.equal(projectMapCardDigest(collapsed), projectMapCardDigest(equivalent), "identically rendered states keep a stable digest");
});

test("a surfaces-only change leaves the painted card and its digest unchanged", () => {
	const original = map();
	const changed = map({ capabilities: original.capabilities.map((capability) => ({ ...capability, surfaces: ["data" as const, "tests" as const] })) });
	assert.notDeepEqual(projectMapCoverage(original), projectMapCoverage(changed), "the map's roll-up really changes");
	assert.deepEqual(projectMapCardDescriptor(ready(changed)), projectMapCardDescriptor(ready(original)));
	assert.equal(projectMapCardDigest(ready(changed)), projectMapCardDigest(ready(original)));
});

test("a painted label change moves the card digest", () => {
	const original = map();
	const changed = map({ capabilities: original.capabilities.map((capability, index) => index === 0 ? { ...capability, outcome: "A different painted label." } : capability) });
	assert.notDeepEqual(projectMapCardDescriptor(ready(changed)), projectMapCardDescriptor(ready(original)));
	assert.notEqual(projectMapCardDigest(ready(changed)), projectMapCardDigest(ready(original)));
});

test("the label uses all the width left after the plain markers", () => {
	const prefix = "  ? ✓ ";
	const outcome = "L".repeat(46 - prefix.length);
	const body = projectMapCardBody(ready(map({ capabilities: [{ ...map().capabilities[0]!, outcome }] })), PROJECT_MAP_EXPANDED, undefined, 46);
	assert.equal(body.lines[body.capabilities[0]!.line], `${prefix}${outcome}`);
});

test("keeps the digest stable when the card does not change and moves when it does", () => {
	const base = projectMapCardDigest(ready(map()));
	assert.equal(projectMapCardDigest(ready(map())), base);
	assert.notEqual(projectMapCardDigest(ready(map()), { foundations: true, capabilities: false }), base, "a collapsed group changes the visible descriptor");
	assert.equal(projectMapCardDigest(ready(map()), PROJECT_MAP_EXPANDED), base);

	const restated = map({ capabilities: [...map().capabilities].reverse() });
	// The reader canonicalizes artifacts, so reordered rows are only reachable through a
	// hand-constructed state; the digest follows the render for every input.
	assert.notEqual(projectMapCardDigest(ready(restated)), base, "rendered row order must move the digest");

	const changed = map({ capabilities: [{ ...map().capabilities[0], state: "blocked" }, map().capabilities[1], map().capabilities[2]] });
	assert.notEqual(projectMapCardDigest(ready(changed)), base);
});

test("distinguishes the three card states in the digest", () => {
	const empty = projectMapCardState("/nonexistent", PROJECT_MAP_OVERLAY_UNAVAILABLE);
	withArtifact(JSON.stringify({ version: PROJECT_MAP_SCHEMA_V1, project: { id: "x", name: "" }, capabilities: [] }), (path) => {
		const invalid = projectMapCardState(path, PROJECT_MAP_OVERLAY_UNAVAILABLE);
		const digests = new Set([projectMapCardDigest(empty), projectMapCardDigest(invalid), projectMapCardDigest(ready(map()))]);
		assert.equal(digests.size, 3);
	});
});

test("renders no overlay rows while the overlay is unavailable", () => {
	const descriptor = projectMapCardDescriptor(ready(map()));
	const body = descriptor.body.join("\n").toLowerCase();
	for (const word of ["claim", "lease", "heartbeat", "worktree", "session-42"]) {
		assert.equal(body.includes(word), false, `expected no ${word} in the card while the overlay is unavailable`);
	}
});

test("keeps every descriptor body line within 60 columns, even with long identifiers", () => {
	const long = map({
		foundations: [{ id: `foundation-${"x".repeat(80)}`, outcome: "Tooling is declared.", state: "done", evidence: [] }],
		capabilities: [{ ...map().capabilities[0], id: `capability-${"y".repeat(80)}`, surfaces: ["web"] }],
	});
	const descriptor = projectMapCardDescriptor(ready(long));
	// The title and subtitle are not pre-wrapped: the subtitle carries the project name and
	// renderCard clips it at render time, which the card suite covers at boundary widths.
	for (const line of descriptor.body) {
		assert.ok(line.length <= 60, `expected a body line under 60 columns, got ${line.length}: ${line}`);
	}
});

test("summarizes completed foundations and capabilities", () => {
	assert.equal(projectMapSummaryLine(map()), "1/1 foundations · 1/3 capabilities");
});

test("bounds long diagnostic messages like the ready body", () => {
	const state: ProjectMapCardState = {
		kind: "invalid",
		path: PROJECT_MAP_ARTIFACT_PATH,
		diagnostics: [{ code: "project-map/invalid-field", path: "$.project.name", message: "z".repeat(200), severity: "error" }],
		overlay: PROJECT_MAP_OVERLAY_UNAVAILABLE,
	};
	const descriptor = projectMapCardDescriptor(state);
	assert.ok(descriptor.body.length > 3, "a long message wraps into continuation lines");
	for (const line of descriptor.body) assert.ok(line.length <= 60, `expected a body line under 60 columns, got ${line.length}: ${line}`);
});

test("classifies an unreadable artifact as empty rather than throwing", () => {
	const directory = mkdtempSync(join(tmpdir(), "project-map-view-"));
	try {
		const path = join(directory, "project-map.json");
		mkdirSync(path);
		const state = projectMapCardState(path, PROJECT_MAP_OVERLAY_UNAVAILABLE);
		assert.equal(state.kind, "empty");
		assert.doesNotThrow(() => projectMapCardDescriptor(state));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("digest follows the rendered descriptor rather than invalid codes or unrendered fields", () => {
	const invalid = (message: string): ProjectMapCardState => ({
		kind: "invalid",
		path: PROJECT_MAP_ARTIFACT_PATH,
		diagnostics: [{ code: "project-map/invalid-field", path: "$.project.name", message, severity: "error" }],
		overlay: PROJECT_MAP_OVERLAY_UNAVAILABLE,
	});
	assert.notEqual(projectMapCardDigest(invalid("Expected a project name.")), projectMapCardDigest(invalid("Project name cannot be blank.")));

	const base = projectMapCardDigest(ready(map()));
	assert.equal(projectMapCardDigest(ready(map({ project: { id: "another-id", name: "Example Shop" } }))), base);
});
