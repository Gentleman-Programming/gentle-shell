import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateProjectMapDraft } from "../lib/shell-project-map-draft.ts";
import {
	compareCapabilitiesForDisplay,
	orderCapabilitiesForDisplay,
} from "../lib/shell-project-map-display-order.ts";
import type { ProjectMapCapabilityV1, ProjectMapV1 } from "../lib/shell-project-map-schema.ts";
import { readProjectMapDisplay } from "../extensions/gentle-project-map.ts";

function capability(id: string, outcome: string, state: ProjectMapCapabilityV1["state"] = "done"): ProjectMapCapabilityV1 {
	return { id, outcome, foundationRefs: [], dependsOn: [], contracts: [], featureDocs: ["odd/tasks/roadmap.md"], surfaces: [], state };
}

function map(capabilities: ProjectMapCapabilityV1[]): ProjectMapV1 {
	return {
		version: "gentle-shell.project-map/v1",
		project: { id: "example-shop", name: "example-shop" },
		approval: { state: "draft" },
		foundations: [{ id: "quality-gates", outcome: "A declared test command", state: "done", evidence: ["package.json"] }],
		capabilities,
	};
}

/** A workspace whose roadmap writes its rows out of functional-point order on purpose. */
function workspace(rows: string[]): string {
	const directory = mkdtempSync(join(tmpdir(), "project-map-display-order-"));
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "example-shop", scripts: { test: "node --test" } }));
	mkdirSync(join(directory, "odd", "tasks"), { recursive: true });
	writeFileSync(join(directory, "odd", "tasks", "roadmap.md"), rows.join("\n"));
	return directory;
}

test("the display orders coded rows naturally, not lexicographically", () => {
	const ordered = orderCapabilitiesForDisplay(map([
		capability("tenth", "FP-10 — Tenth"),
		capability("second", "FP-2 — Second"),
		capability("first-part-two", "FP-1-2 — First, part two"),
		capability("first", "FP-1 — First"),
	]));
	assert.deepEqual(ordered.capabilities.map((entry) => entry.outcome), [
		"FP-1 — First",
		"FP-1-2 — First, part two",
		"FP-2 — Second",
		"FP-10 — Tenth",
	]);
});

test("a row whose label carries no readable code sorts after the coded ones, in identifier order", () => {
	const ordered = orderCapabilitiesForDisplay(map([
		capability("zebra", "Kept without a code"),
		capability("FP-2-title", "FP-2 — Second"),
		capability("alpha", "Also kept without a code"),
		capability("FP-1-title", "FP-1 — First"),
	]));
	assert.deepEqual(ordered.capabilities.map((entry) => entry.id), ["FP-1-title", "FP-2-title", "alpha", "zebra"]);
});

test("a code written without a separator still reads, and a repeated code keeps identifier order", () => {
	const ordered = orderCapabilitiesForDisplay(map([
		capability("b-collision", "FP-3 — Second declaration"),
		capability("bare", "FP-2"),
		capability("a-collision", "FP-3 — First declaration"),
	]));
	assert.deepEqual(ordered.capabilities.map((entry) => entry.id), ["bare", "a-collision", "b-collision"]);
});

test("the projection changes the order and nothing else", () => {
	const before = map([capability("second", "FP-2 — Second"), capability("first", "FP-1 — First")]);
	const after = orderCapabilitiesForDisplay(before);
	assert.deepEqual(after.project, before.project);
	assert.deepEqual(after.approval, before.approval);
	assert.deepEqual(after.foundations, before.foundations);
	assert.deepEqual(after.version, before.version);
	assert.deepEqual(
		[...after.capabilities].sort((left, right) => (left.id < right.id ? -1 : 1)),
		[...before.capabilities].sort((left, right) => (left.id < right.id ? -1 : 1)),
	);
	assert.deepEqual(orderCapabilitiesForDisplay(after).capabilities, after.capabilities);
});

test("a comparator tie is broken by identifier, so the order is total", () => {
	const left = capability("alpha", "FP-7 — One");
	const right = capability("beta", "FP-7 — Another");
	assert.equal(compareCapabilitiesForDisplay(left, right), -1);
	assert.equal(compareCapabilitiesForDisplay(right, left), 1);
	assert.equal(compareCapabilitiesForDisplay(left, left), 0);
});

test("the derived display reads FP order while the generated artifact keeps canonical identifier order", () => {
	// The titles are chosen so the two orders disagree: canonical identifier order is
	// alpha (FP-2), beta (FP-10), zebra (FP-1), while the functional-point order is FP-1, FP-2, FP-10.
	const rows = [
		"- [x] **FP-2 — Alpha**",
		"- [ ] **FP-10 — Beta**",
		"- [x] **FP-1 — Zebra**",
	];
	const directory = workspace(rows);
	try {
		const display = readProjectMapDisplay(directory);
		assert.deepEqual(display.map?.capabilities.map((entry) => entry.outcome), [
			"FP-1 — Zebra",
			"FP-2 — Alpha",
			"FP-10 — Beta",
		]);
		const generated = generateProjectMapDraft({
			packageJson: { name: "example-shop" },
			oddTaskDocuments: [{ path: "odd/tasks/roadmap.md", text: `${rows.join("\n")}\n` }],
		});
		assert.deepEqual(generated.map?.capabilities.map((entry) => entry.outcome), [
			"FP-2 — Alpha",
			"FP-10 — Beta",
			"FP-1 — Zebra",
		]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
