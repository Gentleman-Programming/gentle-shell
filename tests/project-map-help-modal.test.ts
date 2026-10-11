import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildProjectMapHelpContent, ProjectMapHelpModal } from "../lib/project-map-help-modal.ts";
import type { ProjectMapStep } from "../lib/shell-project-map-draft.ts";
import { PROJECT_MAP_STATE_GLYPH } from "../lib/shell-project-map-view.ts";

const theme = { fg: (_role: string, text: string) => text };
const capability = {
	id: "close-the-gate",
	outcome: "Close the gate",
	foundationRefs: [],
	dependsOn: [],
	contracts: [],
	featureDocs: ["odd/tasks/fp-1b-provisioning.md"],
	surfaces: [],
	state: "planned" as const,
};

function modal(description: string[] | null, rows = 40) {
	const results: string[] = [];
	const instance = new ProjectMapHelpModal(
		buildProjectMapHelpContent(capability, description === null ? null : { title: "Close the gate", lines: description }),
		(result) => results.push(result.type),
		theme,
		() => rows,
	);
	return { instance, results };
}

test("frames the answer and names the capability", () => {
	const { instance } = modal(["One line."]);
	const lines = instance.render(60);
	assert.ok(lines[0]!.startsWith("╭"), "the first line opens the frame");
	assert.ok(lines[lines.length - 1]!.startsWith("╰"), "the last line closes it");
	const body = lines.join("\n");
	assert.ok(lines[0]!.includes("close-the-gate"), "the frame carries the capability id");
	assert.ok(lines[0]!.includes("planificada"), "the frame carries its state, in Spanish");
	assert.ok(body.includes("odd/tasks/fp-1b-provisioning.md"), "the document it came from is shown");
	assert.ok(body.includes("One line."), "the description is shown");
});

// A plain label still repeats its normalized id and stays suppressed, but a generated prefixed
// label carries the document's functional-point code and must remain visible.
test("leaves out a repeated plain outcome and renders a prefixed generated outcome once", () => {
	const repeated = new ProjectMapHelpModal(buildProjectMapHelpContent(capability, null), () => {}, theme).render(60).join("\n");
	assert.ok(!repeated.includes("Resultado:"), "a repeated plain outcome is left out");
	const prefixed = new ProjectMapHelpModal(buildProjectMapHelpContent({ ...capability, id: "title", outcome: "FP — Title" }, null), () => {}, theme).render(60).join("\n");
	assert.equal((prefixed.match(/Resultado: FP — Title/g) ?? []).length, 1, "the prefixed outcome is rendered exactly once");
});

test("wraps a long description line instead of truncating it", () => {
	const long = `Start ${"word ".repeat(40)}end`;
	const { instance } = modal([long]);
	const body = instance.render(60).join("\n");
	assert.ok(body.includes("end"), "the tail of a long line survives");
	assert.ok(!body.includes("…"), "a wrapped line is not truncated");
});

test("says plainly when the document declares no such work unit", () => {	const { instance } = modal(null);
	assert.ok(instance.render(60).join("\n").includes("no declara ninguna unidad de trabajo"));
});

test("says plainly when the work unit carries no body", () => {
	const { instance } = modal([]);
	assert.ok(instance.render(60).join("\n").includes("no declara ninguna unidad"));
});

test("closes on escape, enter and ctrl+c, and never twice", () => {
	for (const key of ["\u001b", "\r", "\u0003"]) {
		const { instance, results } = modal(["One line."]);
		instance.handleInput(key);
		instance.handleInput(key);
		assert.deepEqual(results, ["close"], `${JSON.stringify(key)} closes exactly once`);
	}
});

test("scrolls with the arrow and page keys", () => {
	const long = Array.from({ length: 40 }, (_, index) => `line ${index}`);
	const { instance } = modal(long, 20);
	const first = instance.render(60).join("\n");
	assert.ok(first.includes("Superficies: ninguno"), "the first render starts at the facts, before the added roll-up");
	assert.ok(first.includes("↓ "), "and says how much is below it");
	assert.ok(!first.includes("arriba"), "with nothing above it");
	instance.handleInput("\u001b[B");
	assert.ok(instance.render(60).join("\n").includes("↑ 1 arriba"), "a down arrow moves the window by one line");
	instance.handleInput("\u001b[A");
	assert.ok(!instance.render(60).join("\n").includes("arriba"), "an up arrow moves it back to the top");
	instance.handleInput("\u001b[6~");
	const paged = instance.render(60).join("\n");
	assert.ok(paged.includes("line 1"), "a page down lands further in");
	assert.notEqual(paged, first, "and the window moved");
});

test("never exceeds the terminal's row budget", () => {
	const long = Array.from({ length: 200 }, (_, index) => `line ${index}`);
	for (const rows of [12, 20, 40]) {
		const { instance } = modal(long, rows);
		assert.ok(instance.render(60).length <= Math.max(12, Math.floor(rows * 0.85)), `rows=${rows} stayed inside its budget`);
	}
});

test("every rendered line fits the requested width", () => {
	for (const width of [40, 60, 100]) {
		const { instance } = modal([`A description that is longer than any of these widths ${"x".repeat(300)}`]);
		for (const line of instance.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} exceeds ${width}`);
	}
});

test("an empty capability renders its facts and no invented description", () => {
	const content = buildProjectMapHelpContent({ ...capability, featureDocs: [] }, null);
	const instance = new ProjectMapHelpModal(content, () => {}, theme);
	const body = instance.render(60).join("\n");
	assert.ok(body.includes("Documentos: ninguno"), "an empty list is stated, never omitted");
	assert.ok(body.includes("no declara ningún documento"), "no document is named as such");
});

// The retired Inspector alone carried this fact, so the explanation inherits it rather than
// losing it with the surface.
test("lists sub-elements before the unchanged description", () => {
	const description = ["The body stays exactly as it was.", "Its second line stays too."];
	const steps: ProjectMapStep[] = [
		{ code: "FP-1a", title: "Prepare provisioning", state: "done", path: "odd/tasks/provisioning.md" },
		{ code: "FP-1a.1", title: "Create account", state: "active", path: "odd/tasks/provisioning.md" },
		{ code: "FP-1b.0", title: "Prepare delivery", state: "planned", path: "odd/tasks/provisioning.md" },
		{ code: "", title: "Uncoded declared unit", state: "done", path: "odd/tasks/provisioning.md" },
	];
	const before = buildProjectMapHelpContent(capability, { title: "Close the gate", lines: description });
	const content = buildProjectMapHelpContent(capability, { title: "Close the gate", lines: description }, [], undefined, steps);
	assert.deepEqual(content.description, before.description, "the body bytes remain the builder's existing result");
	const rendered = new ProjectMapHelpModal(content, () => {}, theme).render(120).join("\n");
	assert.ok(rendered.indexOf("Subelementos: 4") < rendered.indexOf("Lo que dice el documento:"), "the section precedes the description");
	assert.equal((rendered.match(/Subelementos: 4/g) ?? []).length, 1, "the count is stated once");
	const subelementLines = rendered.split("\n").filter((line) => line.includes("FP-1") || line.includes("Uncoded declared unit"));
	assert.ok(subelementLines.some((line) => line.includes(`  · FP-1a — Prepare provisioning · ${PROJECT_MAP_STATE_GLYPH.done}`)), "a lettered cut is one visible level in");
	assert.ok(subelementLines.some((line) => line.includes(`    · FP-1a.1 — Create account · ${PROJECT_MAP_STATE_GLYPH.active}`)), "a dotted step is two visible levels in");
	assert.ok(subelementLines.some((line) => line.includes(`    · FP-1b.0 — Prepare delivery · ${PROJECT_MAP_STATE_GLYPH.planned}`)));
	assert.ok(subelementLines.some((line) => line.includes(`  · Uncoded declared unit · ${PROJECT_MAP_STATE_GLYPH.done}`)), "an uncoded entry has one depth level and no empty code column");
	assert.equal(subelementLines.some((line) => line.includes("·  — Uncoded declared unit")), false);
	for (const word of ["hecha", "activa", "planificada"]) assert.ok(!subelementLines.some((line) => line.includes(word)), `the sub-element list does not use ${word}`);
	assert.ok(rendered.includes("? close-the-gate · planificada"), "the capability subtitle keeps its Spanish state word");
	assert.ok(rendered.includes(description[0]!));
	assert.ok(rendered.includes(description[1]!));
	const empty = new ProjectMapHelpModal(buildProjectMapHelpContent(capability, { title: "Close the gate", lines: description }), () => {}, theme).render(120).join("\n");
	assert.ok(empty.includes("Subelementos: ninguno"), "an empty sub-element section is explicit");
});

test("places the map roll-up after facts and sub-elements with the description still last", () => {
	const steps: ProjectMapStep[] = [{ code: "FP-1a", title: "Prepare", state: "done", path: "odd/tasks/prepare.md" }];
	const description = { title: "Close the gate", lines: ["Original body."] };
	const rollup = ["Product/UX —", "Web 50% (1/2): gate ✓, catalog ✕", "API —", "Data —", "Security —", "Ops —", "Tests —"];
	const before = buildProjectMapHelpContent(capability, description, ["estado bloqueado"], "Original note.", steps);
	const content = buildProjectMapHelpContent(capability, description, ["estado bloqueado"], "Original note.", steps, rollup);
	assert.deepEqual(content.facts, before.facts);
	assert.deepEqual(content.steps, steps);
	assert.deepEqual(content.description, description.lines);
	const body = new ProjectMapHelpModal(content, () => {}, theme, () => 100).render(120).join("\n");
	const ordered = ["Bloqueos: estado bloqueado", "Subelementos: 1", "FP-1a — Prepare · ✓", "Cobertura por superficie", "Este es el resumen del mapa completo, no de esta capability.", ...rollup, "Original note.", "Lo que dice el documento:", "· Original body."];
	for (let index = 1; index < ordered.length; index++) assert.ok(body.indexOf(ordered[index]!) > body.indexOf(ordered[index - 1]!), `${ordered[index]} follows ${ordered[index - 1]}`);
	assert.ok(body.includes("Superficies: ninguno · Fundamentos: ninguno"));
	assert.ok(body.includes("? close-the-gate · planificada"));
});

test("keeps an explicit map roll-up when no surface or document is declared", () => {
	const rollup = ["Product/UX —", "Web —", "API —", "Data —", "Security —", "Ops —", "Tests —"];
	const content = buildProjectMapHelpContent({ ...capability, featureDocs: [] }, null, [], undefined, [], rollup);
	const body = new ProjectMapHelpModal(content, () => {}, theme, () => 100).render(120).join("\n");
	assert.ok(body.includes("El mapa no declara ninguna superficie."));
	assert.ok(body.indexOf("Subelementos: ninguno.") < body.indexOf("Cobertura por superficie"));
	for (const line of rollup) assert.ok(body.includes(line));
	assert.ok(body.indexOf("Tests —") < body.indexOf("El mapa no declara ningún documento"));
});

test("omitting roll-up lines renders no coverage section or map-level claims", () => {
	const content = buildProjectMapHelpContent({ ...capability, surfaces: ["web"] }, null);
	const body = new ProjectMapHelpModal(content, () => {}, theme, () => 100).render(120).join("\n");
	assert.ok(body.includes("Superficies: web"), "the capability's declared surfaces remain visible");
	assert.ok(!body.includes("Cobertura por superficie"));
	assert.ok(!body.includes("Este es el resumen del mapa completo"));
	assert.ok(!body.includes("no declara ninguna superficie"));
});

test("supplied all-undeclared roll-up renders the coverage section and absence statement", () => {
	const rollup = ["Product/UX —", "Web —", "API —", "Data —", "Security —", "Ops —", "Tests —"];
	const content = buildProjectMapHelpContent(capability, null, [], undefined, [], rollup);
	const body = new ProjectMapHelpModal(content, () => {}, theme, () => 100).render(120).join("\n");
	assert.ok(body.includes("Cobertura por superficie"));
	assert.ok(body.includes("Este es el resumen del mapa completo, no de esta capability."));
	assert.ok(body.includes("El mapa no declara ninguna superficie."));
	for (const line of rollup) assert.ok(body.includes(line));
});

test("wraps supplied roll-up text without dropping its tail", () => {
	const rollup = [`Web 100% (1/1): ${"capability ✓, ".repeat(20)}last-capability ✓`];
	const content = buildProjectMapHelpContent(capability, null, [], undefined, [], rollup);
	const lines = new ProjectMapHelpModal(content, () => {}, theme, () => 100).render(40);
	assert.ok(lines.join("\n").includes("last-capability ✓"));
	for (const line of lines) assert.ok(visibleWidth(line) <= 40);
});

test("states the static blockers, and says none when there are none", () => {
	const withBlockers = new ProjectMapHelpModal(buildProjectMapHelpContent(capability, null, ["estado bloqueado", "dependencia catalog ○"]), () => {}, theme).render(60).join("\n");
	assert.ok(withBlockers.includes("Bloqueos: estado bloqueado, dependencia catalog ○"), "the blockers are stated");
	const withoutBlockers = new ProjectMapHelpModal(buildProjectMapHelpContent(capability, null), () => {}, theme).render(60).join("\n");
	assert.ok(withoutBlockers.includes("Bloqueos: ninguno"), "and an absent blocker is stated too");
});
