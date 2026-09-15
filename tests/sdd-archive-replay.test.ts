import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyDeltaSpec, parseRequirementBlocks } from "../lib/openspec-deltas.ts";

const archive = readFileSync(new URL("../assets/agents/sdd-archive.md", import.meta.url), "utf8");

// These checks exercise the shipped instruction contract, not an autonomous executor.
test("archive reconciles prior composition per operation before applying remaining deltas", () => {
	assert.match(archive, /### Resume prior composition/);
	assert.match(archive, /Classify each operation as already applied, pending, or unresolved/);
	assert.match(archive, /existing change-specific artifacts.*history/);
	assert.match(archive, /PASS.*absence alone.*not proof/);
	assert.match(archive, /REMOVED.*absent.*same requirement.*removed by this change/);
	assert.match(archive, /ADDED.*MODIFIED.*full current requirement block.*intended delta result/);
	assert.match(archive, /Apply only pending operations/);
	assert.match(archive, /unresolved.*before any canonical write or archive move/);
	assert.match(archive, /Do not create a new report schema.*hash inventory/);
});

test("archive reconciliation preserves safety and backend closure boundaries", () => {
	assert.match(archive, /collision.*order.*still apply/);
	assert.match(archive, /Fail or block.*REMOVED target is missing without corroborating history/);
	assert.match(archive, /differing current content.*unresolved/);
	assert.match(archive, /re-read the persisted tasks artifact/i);
	assert.match(archive, /resolved symlink targets/);
	assert.match(archive, /Block rather than overwrite an existing archive destination/);
	assert.match(archive, /Engram.*do not create or require.*canonical/);
	assert.match(archive, /already-applied.*pending.*unresolved.*supporting artifact/);
});

const original = `# Domain

## Requirements

### Requirement: Retained

Keep the original behavior.

### Requirement: Removed

Retire this behavior.
`;
const removal = "## REMOVED Requirements\n\n### Requirement: Removed\n\nRetired by this change.\n";
const modification = "## MODIFIED Requirements\n\n### Requirement: Retained\n\nKeep the revised behavior.\n";
const addition = "## ADDED Requirements\n\n### Requirement: Added\n\nAdd this behavior.\n";

// Existing helpers deliberately reject replay; they do not infer historical ownership.
// Explicit pending inputs below demonstrate composition after instruction-level reconciliation.
test("an already-applied removal is preserved without reapplying it", () => {
	const synced = applyDeltaSpec(original, removal);
	assert.throws(() => applyDeltaSpec(synced, removal), /Missing canonical requirement.*REMOVED/);
	const unchanged = applyDeltaSpec(synced, "");
	assert.equal(unchanged, synced);
	assert.deepEqual(parseRequirementBlocks(unchanged).map((block) => block.name), ["Retained"]);
});

test("unapplied missing removal cannot become a successful helper operation", () => {
	const neverExisted = removal.replaceAll("Removed", "Never existed");
	assert.throws(() => applyDeltaSpec(original, neverExisted), /Missing canonical requirement.*Never existed/);
	assert.match(original, /### Requirement: Removed/);
});

test("mixed prior removal and pending modification/addition compose without duplicating prior effects", () => {
	const partiallySynced = applyDeltaSpec(original, removal);
	const resumed = applyDeltaSpec(partiallySynced, `${modification}\n${addition}`);
	const uninterrupted = applyDeltaSpec(original, `${removal}\n${modification}\n${addition}`);
	assert.equal(resumed, uninterrupted);
	assert.deepEqual(parseRequirementBlocks(resumed).map((block) => block.name), ["Retained", "Added"]);
	assert.throws(() => applyDeltaSpec(resumed, addition), /Cannot add existing canonical requirement/);
});

test("canonical content comparison distinguishes matching effects from later drift", () => {
	const synced = applyDeltaSpec(original, modification);
	const intended = parseRequirementBlocks(modification)[0].content;
	assert.equal(parseRequirementBlocks(synced)[0].content, intended);
	const drifted = synced.replace("Keep the revised behavior.", "A later change owns this behavior.");
	assert.notEqual(parseRequirementBlocks(drifted)[0].content, intended);
	// The helper is not a drift/consent authority: the executor must stop before calling it.
	assert.match(drifted, /A later change owns this behavior/);
	assert.match(applyDeltaSpec(drifted, modification), /Keep the revised behavior/);
});
