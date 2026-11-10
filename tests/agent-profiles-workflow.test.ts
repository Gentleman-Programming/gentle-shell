import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_ORCHESTRATOR_MODE,
	ORCHESTRATOR_MODES,
	readProfileWorkflow,
	normalizeProfilesFile,
	serializeProfilesFile,
	parseProfilesFileText,
	emptyProfilesFile,
	createProfile,
	duplicateProfile,
	renameProfile,
	deleteProfile,
	setProfileOrchestratorMode,
	type AgentProfilesFile,
} from "../lib/agent-profiles.ts";

// ---------------------------------------------------------------------------
// full-delegation-mode S1/S2/S6: the per-profile orchestrator workflow flag.
//
// The flag cannot live inside a profile's routing entries: normalizeProfilesFile
// runs every profile through normalizeModelConfig, whose contract is
// Record<string, AgentRoutingEntry>, so a nested non-routing key is dropped on
// read and reported as a broken role. It therefore travels in a sibling
// `workflow` map keyed by profile name, and these tests lock that contract.
// ---------------------------------------------------------------------------

function fileWith(workflow?: AgentProfilesFile["workflow"]): AgentProfilesFile {
	const base = createProfile(emptyProfilesFile(), "frontier-local", {
		orchestrator: { model: "claude-opus-4-6", thinking: "high" },
		worker: { model: "local/qwen3-coder" },
	});
	const withSecond = createProfile(base, "normal", { orchestrator: { model: "gpt-5.4" } });
	return workflow === undefined ? withSecond : { ...withSecond, workflow };
}

test("a profile with no workflow entry resolves to the organic default", () => {
	assert.equal(DEFAULT_ORCHESTRATOR_MODE, "organic");
	const file = fileWith();
	assert.equal(readProfileWorkflow(file, "normal").orchestratorMode, "organic");
	assert.equal(file.workflow, undefined, "an opted-out file must not gain a workflow map");
});

test("the store round-trips a full-delegation profile without touching its routing", () => {
	const file = setProfileOrchestratorMode(fileWith(), "frontier-local", "full-delegation");
	const text = serializeProfilesFile(file);
	const parsed = parseProfilesFileText(text);
	assert.equal(parsed.status, "valid");
	if (parsed.status !== "valid") return;
	assert.equal(readProfileWorkflow(parsed.file, "frontier-local").orchestratorMode, "full-delegation");
	assert.equal(readProfileWorkflow(parsed.file, "normal").orchestratorMode, "organic");
	// The routing contract is unchanged: the profile still holds only role entries.
	assert.deepEqual(Object.keys(parsed.file.profiles["frontier-local"]).sort(), ["orchestrator", "worker"]);
	assert.equal(parsed.file.profiles["frontier-local"].worker.model, "local/qwen3-coder");
	assert.deepEqual(normalizeProfilesFile(JSON.parse(text))?.drops, { droppedProfiles: [], droppedAgents: [] });
});

test("every declared mode round-trips and nothing else is accepted", () => {
	assert.deepEqual([...ORCHESTRATOR_MODES], ["organic", "full-delegation"]);
	for (const mode of ORCHESTRATOR_MODES) {
		const file = setProfileOrchestratorMode(fileWith(), "normal", mode);
		const parsed = parseProfilesFileText(serializeProfilesFile(file));
		assert.equal(parsed.status, "valid");
		if (parsed.status !== "valid") continue;
		assert.equal(readProfileWorkflow(parsed.file, "normal").orchestratorMode, mode);
	}
});

test("an unknown mode is dropped and reported, never silently honoured", () => {
	const normalized = normalizeProfilesFile({
		kind: "gentle-pi.agent_model_profiles",
		version: 1,
		profiles: { normal: { orchestrator: { model: "gpt-5.4" } } },
		workflow: { normal: { orchestratorMode: "super-delegation" } },
	});
	assert.ok(normalized);
	assert.equal(readProfileWorkflow(normalized.file, "normal").orchestratorMode, "organic");
	assert.deepEqual(normalized.drops.droppedWorkflow, [
		{ profile: "normal", mode: "super-delegation" },
	]);
});

test("a workflow entry naming a profile that does not exist is dropped and reported", () => {
	const normalized = normalizeProfilesFile({
		kind: "gentle-pi.agent_model_profiles",
		version: 1,
		profiles: { normal: { orchestrator: { model: "gpt-5.4" } } },
		workflow: { ghost: { orchestratorMode: "full-delegation" } },
	});
	assert.ok(normalized);
	assert.equal(normalized.file.workflow, undefined);
	assert.deepEqual(normalized.drops.droppedWorkflow, [
		{ profile: "ghost", mode: "full-delegation" },
	]);
});

test("a malformed workflow map is dropped as a whole and never breaks the routing read", () => {
	for (const workflow of [null, 42, "full-delegation", [] as unknown]) {
		const normalized = normalizeProfilesFile({
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			profiles: { normal: { orchestrator: { model: "gpt-5.4" } } },
			workflow,
		});
		assert.ok(normalized, `workflow=${JSON.stringify(workflow)} must not invalidate the file`);
		assert.equal(normalized.file.workflow, undefined);
		assert.deepEqual(Object.keys(normalized.file.profiles), ["normal"]);
	}
});

test("duplicate carries the mode, rename moves it, delete removes it", () => {
	const withMode = setProfileOrchestratorMode(fileWith(), "frontier-local", "full-delegation");

	const duplicated = duplicateProfile(withMode, "frontier-local", "frontier-local-copy");
	assert.equal(readProfileWorkflow(duplicated, "frontier-local-copy").orchestratorMode, "full-delegation");
	assert.equal(readProfileWorkflow(duplicated, "frontier-local").orchestratorMode, "full-delegation");

	const renamed = renameProfile(duplicated, "frontier-local", "frontier-renamed");
	assert.equal(readProfileWorkflow(renamed, "frontier-renamed").orchestratorMode, "full-delegation");
	assert.equal(
		renamed.workflow === undefined ? undefined : Object.hasOwn(renamed.workflow, "frontier-local"),
		false,
		"the old profile name must not keep a workflow entry",
	);

	const deleted = deleteProfile(renamed, "frontier-renamed");
	assert.equal(
		deleted.workflow === undefined ? undefined : Object.hasOwn(deleted.workflow, "frontier-renamed"),
		false,
		"a deleted profile must not leave a workflow entry behind",
	);
	// Everything else keeps its own mode across those rewrites.
	assert.equal(readProfileWorkflow(deleted, "frontier-local-copy").orchestratorMode, "full-delegation");
});

test("serialization omits an empty workflow map and keeps the file head-stable", () => {
	const file = setProfileOrchestratorMode(fileWith(), "normal", "organic");
	const text = serializeProfilesFile(file);
	assert.equal(text.includes("\"workflow\""), false, "an all-organic file must serialize exactly as before");
	const parsed = parseProfilesFileText(text);
	assert.equal(parsed.status, "valid");
});

test("dropping an unknown mode does not disturb an existing valid entry", () => {
	const normalized = normalizeProfilesFile({
		kind: "gentle-pi.agent_model_profiles",
		version: 1,
		profiles: {
			normal: { orchestrator: { model: "gpt-5.4" } },
			"frontier-local": { orchestrator: { model: "claude-opus-4-6" } },
		},
		workflow: {
			normal: { orchestratorMode: "nope" },
			"frontier-local": { orchestratorMode: "full-delegation" },
		},
	});
	assert.ok(normalized);
	assert.equal(readProfileWorkflow(normalized.file, "frontier-local").orchestratorMode, "full-delegation");
	assert.equal(readProfileWorkflow(normalized.file, "normal").orchestratorMode, "organic");
	assert.deepEqual(normalized.drops.droppedWorkflow, [{ profile: "normal", mode: "nope" }]);
});
