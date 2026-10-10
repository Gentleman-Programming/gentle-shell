import assert from "node:assert/strict";
import test from "node:test";
import { readProjectMapWorkUnit } from "../lib/shell-project-map-draft.ts";
import { readCapabilityDescription } from "../lib/project-map-description.ts";

const DOCUMENT = [
	"# FP-1b — Provisioning",
	"",
	"## Objective",
	"",
	"Turn the declared deployment shape into a real one.",
	"",
	"## Work units",
	"",
	"- [ ] **FP-1b.1 — Supabase project: database and identity**",
	"  - Create the managed PostgreSQL project and its identity provider.",
	"  - Store every credential outside migrations, in the provider secret store.",
	"",
	"- [x] **FP-1b.2 — Railway: the API service** (deployable now)",
	"  - Deploy the API with the repository's own preflight script.",
	"",
	"- [ ] **FP-1b.3 — Domain and DNS**",
	"",
	"## Notes",
	"",
	"Everything above is non-secret by construction.",
	"",
].join("\n");

test("returns the body of the work unit whose title normalizes to the capability id", () => {
	const description = readCapabilityDescription(DOCUMENT, "supabase-project-database-and-identity");
	assert.ok(description, "expected the work unit to be found");
	assert.equal(description.title, "Supabase project: database and identity");
	assert.deepEqual(description.lines, [
		"Create the managed PostgreSQL project and its identity provider.",
		"Store every credential outside migrations, in the provider secret store.",
	]);
});

// The generator now shares the same trailing-text tolerance. The reader remains more tolerant
// only about indentation, so it can explain a nested work unit the top-level map deliberately
// does not turn into a capability.
test("tolerates trailing text after the closing emphasis", () => {
	const description = readCapabilityDescription(DOCUMENT, "railway-the-api-service");
	assert.ok(description, "expected a work unit with trailing text to be found");
	assert.equal(description.title, "Railway: the API service");
	assert.deepEqual(description.lines, ["Deploy the API with the repository's own preflight script."]);
});

test("resolves an active work unit by its generated truncated id", () => {
	const document = [
		"- [~] **FP-6 — Merchant order notification worker producer gate and reconciliation**",
		"  - Publish an order notification after the producer gate passes.",
		"",
	].join("\n");
	assert.deepEqual(readCapabilityDescription(document, "merchant-order-notification-worker-producer-gate-and"), {
		title: "Merchant order notification worker producer gate and reconciliation",
		lines: ["Publish an order notification after the producer gate passes."],
	});
});

test("tolerates runs of whitespace around a work-unit marker", () => {
	const document = [
		"-  [ ] **X**",
		"  - Its first body remains available.",
		"-\t[ ] **Tab**",
		"  - Its second body remains available.",
		"- [ ]  **FP-5 — Two spaces**",
		"  - Its third body remains available.",
		"",
	].join("\n");
	assert.deepEqual(readCapabilityDescription(document, "x"), {
		title: "X",
		lines: ["Its first body remains available."],
	});
	assert.deepEqual(readCapabilityDescription(document, "tab"), {
		title: "Tab",
		lines: ["Its second body remains available."],
	});
	assert.deepEqual(readCapabilityDescription(document, "two-spaces"), {
		title: "Two spaces",
		lines: ["Its third body remains available."],
	});
});

test("continues to resolve a nested work unit", () => {
	const document = ["  - [ ] **FP-5.1 — Nested unit**", "    - Its body remains available.", ""].join("\n");
	assert.deepEqual(readCapabilityDescription(document, "nested-unit"), {
		title: "Nested unit",
		lines: ["Its body remains available."],
	});
});

test("matches the whole title when the label carries no separator", () => {
	const document = ["- [ ] **Close the gate**", "  - One body line.", ""].join("\n");
	const description = readCapabilityDescription(document, "close-the-gate");
	assert.ok(description);
	assert.equal(description.title, "Close the gate");
	assert.deepEqual(description.lines, ["One body line."]);
});

test("a work unit with no body is found, with an empty body rather than null", () => {
	const description = readCapabilityDescription(DOCUMENT, "domain-and-dns");
	assert.ok(description, "expected the work unit to be found");
	assert.deepEqual(description.lines, []);
});

test("stops at the next work unit and at an unindented line", () => {
	const description = readCapabilityDescription(DOCUMENT, "supabase-project-database-and-identity");
	assert.ok(description);
	assert.ok(!description.lines.some((line) => line.includes("Deploy the API")), "the next work unit's body is not this one's");
	assert.ok(!description.lines.some((line) => line.includes("non-secret")), "the section after the list is not a body");
});

test("strips the bullet marker and normalizes whitespace, keeping the text verbatim", () => {
	const document = ["- [ ] **Catalog**", "  -   Two   spaces   collapse, and `code` stays.", "  * A star bullet works too.", ""].join("\n");
	const description = readCapabilityDescription(document, "catalog");
	assert.ok(description);
	assert.deepEqual(description.lines, ["Two spaces collapse, and `code` stays.", "A star bullet works too."]);
});

test("does not match a work unit whose title normalizes to a different id", () => {
	assert.equal(readCapabilityDescription(DOCUMENT, "supabase-project"), null);
	assert.equal(readCapabilityDescription(DOCUMENT, "not-a-work-unit"), null);
});

test("an empty document and an empty id answer nothing rather than throwing", () => {
	assert.equal(readCapabilityDescription("", "catalog"), null);
	assert.equal(readCapabilityDescription(DOCUMENT, ""), null);
});

test("the shared work-unit reader preserves the description reader's title and body contract", () => {
	const expected = readCapabilityDescription(DOCUMENT, "supabase-project-database-and-identity");
	assert.deepEqual(readProjectMapWorkUnit(DOCUMENT, "supabase-project-database-and-identity"), expected);
});

test("the shared work-unit reader returns null for an id its document does not declare", () => {
	assert.equal(readProjectMapWorkUnit(DOCUMENT, "not-a-work-unit"), null);
});
