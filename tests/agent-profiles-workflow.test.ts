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
	setProfileControlledEngineering,
	toggleProfileOrchestratorMode,
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

// ---------------------------------------------------------------------------
// controlled-engineering S1/S4: the per-profile Controlled Engineering option
// rides the same `workflow` entry as the orchestrator mode. Off is the
// default and is never written, so a profile that does not enable it keeps
// today's bytes.
// ---------------------------------------------------------------------------

const TODAYS_BYTES = `${JSON.stringify({
	kind: "gentle-pi.agent_model_profiles",
	version: 1,
	profiles: {
		"frontier-local": {
			orchestrator: { model: "claude-opus-4-6", thinking: "high" },
			worker: { model: "local/qwen3-coder" },
		},
		normal: { orchestrator: { model: "gpt-5.4" } },
	},
	workflow: { "frontier-local": { orchestratorMode: "full-delegation" } },
}, null, 2)}\n`;

test("Controlled Engineering off: the store keeps today's bytes and reads as off", () => {
	const today = setProfileOrchestratorMode(fileWith(), "frontier-local", "full-delegation");
	assert.equal(serializeProfilesFile(today), TODAYS_BYTES);
	// Turning the option off where it was never on writes nothing new.
	const off = setProfileControlledEngineering(today, "normal", false);
	assert.equal(serializeProfilesFile(off), TODAYS_BYTES);
	// A file written before the option existed reads as off for every profile.
	const parsed = parseProfilesFileText(TODAYS_BYTES);
	assert.equal(parsed.status, "valid");
	if (parsed.status !== "valid") return;
	assert.equal(readProfileWorkflow(parsed.file, "frontier-local").controlledEngineering, false);
	assert.equal(readProfileWorkflow(parsed.file, "normal").controlledEngineering, false);
	assert.equal(serializeProfilesFile(parsed.file), TODAYS_BYTES);
});

test("Controlled Engineering on persists beside any orchestrator mode and survives a round trip", () => {
	let file = setProfileOrchestratorMode(fileWith(), "frontier-local", "full-delegation");
	file = setProfileControlledEngineering(file, "frontier-local", true);
	file = setProfileControlledEngineering(file, "normal", true);
	const text = serializeProfilesFile(file);
	assert.deepEqual(JSON.parse(text).workflow, {
		"frontier-local": { orchestratorMode: "full-delegation", controlledEngineering: true },
		normal: { orchestratorMode: "organic", controlledEngineering: true },
	});
	const normalized = normalizeProfilesFile(JSON.parse(text));
	assert.ok(normalized);
	assert.equal(normalized.drops.droppedWorkflow, undefined);
	const reparsed = parseProfilesFileText(serializeProfilesFile(normalized.file));
	assert.equal(reparsed.status, "valid");
	if (reparsed.status !== "valid") return;
	assert.deepEqual(readProfileWorkflow(reparsed.file, "frontier-local"), { orchestratorMode: "full-delegation", controlledEngineering: true });
	assert.deepEqual(readProfileWorkflow(reparsed.file, "normal"), { orchestratorMode: "organic", controlledEngineering: true });
	// Each setting changes alone: the mode back to organic keeps the option, the
	// option off keeps the mode, and an entry with neither is removed.
	const organic = setProfileOrchestratorMode(reparsed.file, "frontier-local", "organic");
	assert.deepEqual(readProfileWorkflow(organic, "frontier-local"), { orchestratorMode: "organic", controlledEngineering: true });
	const plain = setProfileControlledEngineering(organic, "frontier-local", false);
	assert.equal(plain.workflow !== undefined && Object.hasOwn(plain.workflow, "frontier-local"), false);
	assert.deepEqual(JSON.parse(serializeProfilesFile(plain)).workflow, { normal: { orchestratorMode: "organic", controlledEngineering: true } });
});

test("duplicate copies Controlled Engineering with the mode, rename moves it, delete removes it", () => {
	const file = setProfileControlledEngineering(setProfileOrchestratorMode(fileWith(), "frontier-local", "full-delegation"), "frontier-local", true);
	const duplicated = duplicateProfile(file, "frontier-local", "copy");
	assert.deepEqual(readProfileWorkflow(duplicated, "copy"), { orchestratorMode: "full-delegation", controlledEngineering: true });
	const organicOnly = setProfileControlledEngineering(fileWith(), "normal", true);
	assert.deepEqual(readProfileWorkflow(duplicateProfile(organicOnly, "normal", "normal-copy"), "normal-copy"), { orchestratorMode: "organic", controlledEngineering: true });
	const renamed = renameProfile(duplicated, "copy", "renamed");
	assert.equal(readProfileWorkflow(renamed, "renamed").controlledEngineering, true);
	const deleted = deleteProfile(renamed, "renamed");
	assert.equal(deleted.workflow !== undefined && Object.hasOwn(deleted.workflow, "renamed"), false);
});

test("a Controlled Engineering value other than true reads as off and drops nothing", () => {
	const normalized = normalizeProfilesFile({
		kind: "gentle-pi.agent_model_profiles",
		version: 1,
		profiles: {
			normal: { orchestrator: { model: "gpt-5.4" } },
			"frontier-local": { orchestrator: { model: "claude-opus-4-6" } },
		},
		workflow: {
			normal: { orchestratorMode: "full-delegation", controlledEngineering: "yes" },
			"frontier-local": { orchestratorMode: "organic", controlledEngineering: false },
		},
	});
	assert.ok(normalized);
	// The valid mode survives; only exactly `true` turns the option on.
	assert.deepEqual(readProfileWorkflow(normalized.file, "normal"), { orchestratorMode: "full-delegation", controlledEngineering: false });
	assert.equal(normalized.drops.droppedWorkflow, undefined);
	assert.deepEqual(JSON.parse(serializeProfilesFile(normalized.file)).workflow, { normal: { orchestratorMode: "full-delegation" } });
});

test("the orchestrator mode still persists and toggles as before (preserved)", () => {
	const delegated = toggleProfileOrchestratorMode(fileWith(), "normal");
	assert.deepEqual(JSON.parse(serializeProfilesFile(delegated)).workflow, { normal: { orchestratorMode: "full-delegation" } });
	const back = toggleProfileOrchestratorMode(delegated, "normal");
	assert.equal(serializeProfilesFile(back).includes("\"workflow\""), false);
});
