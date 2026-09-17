import assert from "node:assert/strict";
import test from "node:test";
import {
	applyDeltaSpec,
	parseDeltaSpec,
	parseRequirementBlocks,
} from "../lib/openspec-deltas.ts";

const canonicalSpec = `# Example Specification

## Purpose

Example domain.

## Requirements

### Requirement: Existing Behavior

The system MUST keep existing behavior.

#### Scenario: Happy path

- GIVEN an existing condition
- WHEN the action runs
- THEN existing behavior is preserved

---

### Requirement: Deprecated Behavior

The system MUST support old behavior.

#### Scenario: Old path

- GIVEN an old condition
- WHEN the action runs
- THEN old behavior is preserved
`;

const deltaSpec = `# Delta for Example

## ADDED Requirements

### Requirement: New Behavior

The system MUST support new behavior.

#### Scenario: New path

- GIVEN a new condition
- WHEN the action runs
- THEN new behavior is available

## MODIFIED Requirements

### Requirement: Existing Behavior

The system MUST keep existing behavior and report audit evidence.
(Previously: existing behavior did not report audit evidence)

#### Scenario: Happy path

- GIVEN an existing condition
- WHEN the action runs
- THEN existing behavior is preserved
- AND audit evidence is recorded

## REMOVED Requirements

### Requirement: Deprecated Behavior

(Reason: old behavior is no longer supported)
`;

test("parseRequirementBlocks extracts requirement blocks with names", () => {
	const blocks = parseRequirementBlocks(canonicalSpec);

	assert.deepEqual(
		blocks.map((block) => block.name),
		["Existing Behavior", "Deprecated Behavior"],
	);
	assert.match(blocks[0].content, /Scenario: Happy path/);
	assert.match(blocks[1].content, /old behavior/i);
});

test("parseDeltaSpec extracts ADDED, MODIFIED, and REMOVED sections", () => {
	const delta = parseDeltaSpec(deltaSpec);

	assert.deepEqual(
		delta.added.map((block) => block.name),
		["New Behavior"],
	);
	assert.deepEqual(
		delta.modified.map((block) => block.name),
		["Existing Behavior"],
	);
	assert.deepEqual(
		delta.removed.map((block) => block.name),
		["Deprecated Behavior"],
	);
});

test("applyDeltaSpec applies ADDED, MODIFIED, and REMOVED while preserving unrelated content", () => {
	const result = applyDeltaSpec(canonicalSpec, deltaSpec);

	assert.match(result, /### Requirement: New Behavior/);
	assert.match(result, /audit evidence is recorded/);
	assert.doesNotMatch(result, /### Requirement: Deprecated Behavior/);
	assert.match(result, /# Example Specification/);
	assert.match(result, /## Purpose/);
	assert.match(result, /## Requirements/);
});

test("applyDeltaSpec preserves sections after Requirements when appending ADDED", () => {
	const result = applyDeltaSpec(
		`${canonicalSpec}\n## Notes\n\nKeep this section.\n`,
		`# Delta

## ADDED Requirements

### Requirement: New Behavior

The system MUST support new behavior.
`,
	);

	assert.match(result, /### Requirement: New Behavior[\s\S]*\n\n## Notes\n\nKeep this section\./);
	assert.doesNotMatch(result, /Behavior## Notes/);
});

test("applyDeltaSpec does not duplicate separators between multiple ADDED requirements", () => {
	const result = applyDeltaSpec(
		canonicalSpec,
		`# Delta

## ADDED Requirements

### Requirement: First New Behavior

The system MUST support the first behavior.

---

### Requirement: Second New Behavior

The system MUST support the second behavior.
`,
	);

	assert.match(result, /### Requirement: First New Behavior[\s\S]*---[\s\S]*### Requirement: Second New Behavior/);
	assert.doesNotMatch(result, /---\n\n---/);
});

test("applyDeltaSpec rejects MODIFIED requirements that do not exist", () => {
	assert.throws(
		() =>
			applyDeltaSpec(
				canonicalSpec,
				`# Delta

## MODIFIED Requirements

### Requirement: Missing Behavior

The system MUST fail.
`,
			),
		/missing canonical requirement.*Missing Behavior/i,
	);
});

test("applyDeltaSpec rejects REMOVED requirements that do not exist", () => {
	assert.throws(
		() =>
			applyDeltaSpec(
				canonicalSpec,
				`# Delta

## REMOVED Requirements

### Requirement: Missing Behavior

(Reason: already absent)
`,
			),
		/missing canonical requirement.*Missing Behavior/i,
	);
});

test("applyDeltaSpec rejects duplicate operations for the same requirement", () => {
	assert.throws(
		() =>
			parseDeltaSpec(`# Delta

## ADDED Requirements

### Requirement: Same Behavior

The system MUST do one thing.

## REMOVED Requirements

### Requirement: Same Behavior

(Reason: conflict)
`),
		/duplicate delta operation.*Same Behavior/i,
	);
});

test("parseRequirementBlocks preserves internal markdown horizontal rules and only removes trailing separator", () => {
	const specWithInternalDivider = `# Specification

## Requirements

### Requirement: Internal Divider Behavior

The system MUST support structured content.

---

Here is additional details after an internal divider.

---

### Requirement: Next Requirement

Another requirement.
`;

	const blocks = parseRequirementBlocks(specWithInternalDivider);
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].name, "Internal Divider Behavior");
	assert.match(
		blocks[0].content,
		/The system MUST support structured content\.\n\n---\n\nHere is additional details after an internal divider\./,
	);
	assert.doesNotMatch(blocks[0].content, /---\s*$/);
	assert.equal(blocks[1].name, "Next Requirement");
});

