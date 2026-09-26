import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
	AgentProfileError,
	bootstrapProfilesFile,
	buildProfileListItems,
	createProfile,
	deleteProfile,
	duplicateProfile,
	emptyProfilesFile,
	formatOrchestratorSelection,
	formatProfileSummaryLines,
	formatRoutingRow,
	isValidProfileName,
	normalizeProfilesFile,
	parseProfileExportText,
	parseProfileExportTextWithDrops,
	parseProfilesFileText,
	PROFILE_EXPORT_KIND,
	PROFILE_EXPORT_VERSION,
	PROFILE_ORCHESTRATOR_KEY,
	PROFILES_KIND,
	PROFILES_VERSION,
	profileExportPath,
	profileRoleEntries,
	profileRoutingRows,
	profilesFilePath,
	readProfileOrchestrator,
	readProfilesFileResult,
	renameProfile,
	routingColumnWidths,
	serializeProfileExport,
	serializeProfilesFile,
	setActiveProfile,
	summarizeProfile,
	updateProfile,
	writeJsonFileAtomicallySync,
	writeProfilesFileSync,
} from "../lib/agent-profiles.ts";
import type { AgentModelConfig } from "../lib/model-routing-authority.ts";

// Agent-model profiles: pure store, summary, and export logic for the
// /gentle:profiles panel. These tests perform zero filesystem access — every
// tested function operates on strings and plain objects.

const CONFIG: AgentModelConfig = {
	explore: { model: "openai-codex/gpt-5.6-terra", thinking: "low" },
	design: { model: "anthropic/claude-sonnet-4", thinking: "high" },
};

function profilesText(profiles: unknown, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		kind: PROFILES_KIND,
		version: PROFILES_VERSION,
		profiles,
		...overrides,
	});
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}


test("isValidProfileName accepts slug names and rejects reserved and malformed names", () => {
	assert.equal(isValidProfileName("current"), true);
	assert.equal(isValidProfileName("deep-work"), true);
	assert.equal(isValidProfileName("Team.Prod_2"), true);
	assert.equal(isValidProfileName("a"), true);
	assert.equal(isValidProfileName("x".repeat(64)), true);
	assert.equal(isValidProfileName(""), false);
	assert.equal(isValidProfileName("-leading"), false);
	assert.equal(isValidProfileName(".hidden"), false);
	assert.equal(isValidProfileName("has space"), false);
	assert.equal(isValidProfileName("bad/name"), false);
	assert.equal(isValidProfileName("x".repeat(65)), false);
	assert.equal(isValidProfileName(42), false);
	assert.equal(isValidProfileName(undefined), false);
	assert.equal(isValidProfileName("__proto__"), false);
	assert.equal(isValidProfileName("constructor"), false);
	assert.equal(isValidProfileName("prototype"), false);
});

test("emptyProfilesFile returns a versioned empty store", () => {
	assert.deepEqual(emptyProfilesFile(), {
		kind: PROFILES_KIND,
		version: PROFILES_VERSION,
		active: undefined,
		profiles: {},
	});
});

test("parseProfilesFileText rejects malformed JSON without throwing", () => {
	assert.deepEqual(parseProfilesFileText("{not json"), { status: "invalid" });
	assert.deepEqual(parseProfilesFileText(""), { status: "invalid" });
	assert.deepEqual(parseProfilesFileText("[1, 2]"), { status: "invalid" });
	assert.deepEqual(parseProfilesFileText('"profiles"'), { status: "invalid" });
});

test("parseProfilesFileText never accepts a wrong kind or version", () => {
	assert.deepEqual(
		parseProfilesFileText(profilesText({ team: CONFIG }, { kind: "other.kind" })),
		{ status: "invalid" },
	);
	assert.deepEqual(
		parseProfilesFileText(profilesText({ team: CONFIG }, { version: 2 })),
		{ status: "invalid" },
	);
	assert.deepEqual(
		parseProfilesFileText(profilesText({ team: CONFIG }, { version: "1" })),
		{ status: "invalid" },
	);
});

test("parseProfilesFileText rejects a file whose profiles are not a record", () => {
	assert.deepEqual(parseProfilesFileText(profilesText([CONFIG])), { status: "invalid" });
});

test("parseProfilesFileText accepts a valid store and drops profiles with invalid names", () => {
	const parsed = parseProfilesFileText(
		profilesText(
			{
				"has space": CONFIG,
				"__proto__": { explore: { model: "m/x" } },
				constructor: { explore: { model: "m/x" } },
				team: CONFIG,
			},
			{ active: "has space" },
		),
	);
	assert.deepEqual(parsed, {
		status: "valid",
		file: {
			kind: PROFILES_KIND,
			version: PROFILES_VERSION,
			active: undefined,
			profiles: { team: CONFIG },
		},
	});
});

test("parseProfilesFileText accepts legacy string routing entries and drops broken agents", () => {
	const parsed = parseProfilesFileText(
		profilesText({
			team: {
				explore: "openai-codex/gpt-5.6-terra",
				"bad agent": { model: "m/x" },
				empty: {},
			},
		}),
	);
	assert.deepEqual(parsed, {
		status: "valid",
		file: {
			kind: PROFILES_KIND,
			version: PROFILES_VERSION,
			active: undefined,
			profiles: {
				team: {
					explore: { model: "openai-codex/gpt-5.6-terra" },
					empty: {},
				},
			},
		},
	});
});

test("serializeProfilesFile round-trips through parseProfilesFileText with a trailing newline", () => {
	const file = setActiveProfile(createProfile(emptyProfilesFile(), "team", CONFIG), "team");
	const text = serializeProfilesFile(file);
	assert.ok(text.endsWith("}\n"));
	assert.deepEqual(parseProfilesFileText(text), { status: "valid", file });
});

test("serializeProfilesFile omits the active field when no profile is active", () => {
	const text = serializeProfilesFile(createProfile(emptyProfilesFile(), "team", CONFIG));
	assert.ok(!text.includes('"active"'));
});

test("createProfile adds a profile without mutating the input", () => {
	const file = emptyProfilesFile();
	const before = structuredClone(file);
	const next = createProfile(file, "team", CONFIG);
	assert.deepEqual(file, before);
	assert.deepEqual(next.profiles.team, CONFIG);
	assert.equal(hasOwn(next.profiles, "team"), true);
});

test("createProfile clones the given config so later edits cannot leak", () => {
	const config: AgentModelConfig = { explore: { model: "m/x" } };
	const next = createProfile(emptyProfilesFile(), "team", config);
	next.profiles.team.explore.model = "changed";
	assert.equal(config.explore.model, "m/x");
});

test("createProfile throws typed errors on invalid and duplicate names", () => {
	const file = createProfile(emptyProfilesFile(), "team", CONFIG);
	assert.throws(
		() => createProfile(file, "bad name", CONFIG),
		(error: unknown) => error instanceof AgentProfileError && error.code === "invalid_name",
	);
	assert.throws(
		() => createProfile(file, "constructor", CONFIG),
		(error: unknown) => error instanceof AgentProfileError && error.code === "invalid_name",
	);
	assert.throws(
		() => createProfile(file, "team", CONFIG),
		(error: unknown) => error instanceof AgentProfileError && error.code === "duplicate_name",
	);
});

test("updateProfile replaces the config without mutating the input and throws when missing", () => {
	const file = createProfile(emptyProfilesFile(), "team", CONFIG);
	const before = structuredClone(file);
	const next = updateProfile(file, "team", { explore: { model: "m/y" } });
	assert.deepEqual(file, before);
	assert.deepEqual(next.profiles.team, { explore: { model: "m/y" } });
	assert.throws(
		() => updateProfile(file, "missing", CONFIG),
		(error: unknown) => error instanceof AgentProfileError && error.code === "missing_profile",
	);
	assert.throws(
		() => updateProfile(file, "__proto__", CONFIG),
		(error: unknown) => error instanceof AgentProfileError && error.code === "invalid_name",
	);
});

test("duplicateProfile copies the config under a new name", () => {
	const file = createProfile(emptyProfilesFile(), "team", CONFIG);
	const next = duplicateProfile(file, "team", "team-2");
	assert.deepEqual(next.profiles["team-2"], CONFIG);
	assert.deepEqual(next.profiles.team, CONFIG);
	assert.equal(next.active, undefined);
	assert.throws(
		() => duplicateProfile(file, "missing", "other"),
		(error: unknown) => error instanceof AgentProfileError && error.code === "missing_profile",
	);
	assert.throws(
		() => duplicateProfile(file, "team", "team"),
		(error: unknown) => error instanceof AgentProfileError && error.code === "duplicate_name",
	);
	assert.throws(
		() => duplicateProfile(file, "team", "bad name"),
		(error: unknown) => error instanceof AgentProfileError && error.code === "invalid_name",
	);
});

test("renameProfile carries the active marker over and keeps the input untouched", () => {
	let file = createProfile(emptyProfilesFile(), "team", CONFIG);
	file = setActiveProfile(file, "team");
	const before = structuredClone(file);
	const next = renameProfile(file, "team", "deep-work");
	assert.deepEqual(file, before);
	assert.equal(hasOwn(next.profiles, "team"), false);
	assert.deepEqual(next.profiles["deep-work"], CONFIG);
	assert.equal(next.active, "deep-work");
});

test("renameProfile leaves the active marker alone for other profiles", () => {
	let file = createProfile(emptyProfilesFile(), "team", CONFIG);
	file = createProfile(file, "other", {});
	file = setActiveProfile(file, "other");
	const next = renameProfile(file, "team", "deep-work");
	assert.equal(next.active, "other");
});

test("renameProfile throws typed errors for missing, duplicate, and invalid names", () => {
	const file = createProfile(emptyProfilesFile(), "team", CONFIG);
	assert.throws(
		() => renameProfile(file, "missing", "other"),
		(error: unknown) => error instanceof AgentProfileError && error.code === "missing_profile",
	);
	assert.throws(
		() => renameProfile(file, "team", "team"),
		(error: unknown) => error instanceof AgentProfileError && error.code === "duplicate_name",
	);
	assert.throws(
		() => renameProfile(file, "team", "bad name"),
		(error: unknown) => error instanceof AgentProfileError && error.code === "invalid_name",
	);
});

test("deleteProfile removes a profile but refuses to delete the active one", () => {
	let file = createProfile(emptyProfilesFile(), "team", CONFIG);
	file = createProfile(file, "other", {});
	const before = structuredClone(file);
	const next = deleteProfile(file, "team");
	assert.deepEqual(file, before);
	assert.equal(hasOwn(next.profiles, "team"), false);
	assert.deepEqual(next.profiles.other, {});

	file = setActiveProfile(file, "team");
	assert.throws(
		() => deleteProfile(file, "team"),
		(error: unknown) => error instanceof AgentProfileError && error.code === "active_profile",
	);
	assert.throws(
		() => deleteProfile(file, "missing"),
		(error: unknown) => error instanceof AgentProfileError && error.code === "missing_profile",
	);
});

test("setActiveProfile marks an existing profile and throws otherwise", () => {
	const file = createProfile(emptyProfilesFile(), "team", CONFIG);
	assert.equal(setActiveProfile(file, "team").active, "team");
	assert.throws(
		() => setActiveProfile(file, "missing"),
		(error: unknown) => error instanceof AgentProfileError && error.code === "missing_profile",
	);
	assert.throws(
		() => setActiveProfile(file, "prototype"),
		(error: unknown) => error instanceof AgentProfileError && error.code === "invalid_name",
	);
});

test("summarizeProfile groups roles per model and sorts by count desc then model asc", () => {
	const summary = summarizeProfile({
		gamma: { model: "a/one" },
		alpha: { model: "b/two" },
		beta: { model: "b/two" },
		delta: { model: "a/one" },
		echo: { model: "a/one" },
	});
	assert.deepEqual(summary, {
		models: [
			{ model: "a/one", count: 3, roles: ["delta", "echo", "gamma"] },
			{ model: "b/two", count: 2, roles: ["alpha", "beta"] },
		],
		total: 5,
	});
});

test("summarizeProfile labels model-less entries as inherit and handles empty configs", () => {
	assert.deepEqual(summarizeProfile({ solo: { thinking: "high" } }), {
		models: [{ model: "inherit", count: 1, roles: ["solo"] }],
		total: 1,
	});
	assert.deepEqual(summarizeProfile({}), { models: [], total: 0 });
});

test("profile export round-trips through serialize and parse", () => {
	const text = serializeProfileExport("team", CONFIG);
	assert.ok(text.endsWith("}\n"));
	assert.deepEqual(parseProfileExportText(text), { name: "team", config: CONFIG });
});

test("profile export parse rejects malformed, wrong-kind, wrong-version, and invalid-name payloads", () => {
	assert.equal(parseProfileExportText("{nope"), undefined);
	assert.equal(
		parseProfileExportText(JSON.stringify({ kind: "other", version: PROFILE_EXPORT_VERSION, name: "team", config: CONFIG })),
		undefined,
	);
	assert.equal(
		parseProfileExportText(JSON.stringify({ kind: PROFILE_EXPORT_KIND, version: 99, name: "team", config: CONFIG })),
		undefined,
	);
	assert.equal(
		parseProfileExportText(JSON.stringify({ kind: PROFILE_EXPORT_KIND, version: PROFILE_EXPORT_VERSION, config: CONFIG })),
		undefined,
	);
	assert.equal(
		parseProfileExportText(JSON.stringify({ kind: PROFILE_EXPORT_KIND, version: PROFILE_EXPORT_VERSION, name: "bad name", config: CONFIG })),
		undefined,
	);
	assert.equal(
		parseProfileExportText(JSON.stringify({ kind: PROFILE_EXPORT_KIND, version: PROFILE_EXPORT_VERSION, name: "team", config: "nope" })),
		undefined,
	);
});

test("serializeProfileExport throws on an invalid profile name", () => {
	assert.throws(
		() => serializeProfileExport("bad name", CONFIG),
		(error: unknown) => error instanceof AgentProfileError && error.code === "invalid_name",
	);
});

test("profile export parse names dropped routing entries without dropping the profile", () => {
	const text = JSON.stringify({
		kind: PROFILE_EXPORT_KIND,
		version: PROFILE_EXPORT_VERSION,
		name: "team",
		config: {
			explore: { model: "m/x" },
			"bad agent": { model: "m/x" },
			broken: "not an entry",
		},
	});
	const parsed = parseProfileExportTextWithDrops(text);
	assert.deepEqual(parsed, {
		name: "team",
		config: { explore: { model: "m/x", thinking: undefined } },
		droppedAgents: ["bad agent", "broken"],
	});
});

test("normalizeProfilesFile validates shape, drops invalid entries, and reports them", () => {
	assert.equal(normalizeProfilesFile("nope"), undefined);
	assert.equal(normalizeProfilesFile({ kind: PROFILES_KIND, version: PROFILES_VERSION }), undefined);
	assert.equal(normalizeProfilesFile({ kind: "other", version: PROFILES_VERSION, profiles: {} }), undefined);
	assert.equal(normalizeProfilesFile({ kind: PROFILES_KIND, version: 3, profiles: {} }), undefined);

	const normalized = normalizeProfilesFile(
		JSON.parse(
			profilesText(
				{
					"bad name": CONFIG,
					broken: "not a record",
					team: { explore: { model: "m/x" }, "bad agent": { model: "m/y" } },
				},
				{ active: "team" },
			),
		),
	);
	assert.deepEqual(normalized, {
		file: {
			kind: PROFILES_KIND,
			version: PROFILES_VERSION,
			active: "team",
			profiles: { team: { explore: { model: "m/x", thinking: undefined } } },
		},
		drops: {
			droppedProfiles: ["bad name", "broken"],
			droppedAgents: [{ profile: "team", agent: "bad agent" }],
		},
	});
});

test("normalizeProfilesFile drops an active marker that points nowhere", () => {
	const normalized = normalizeProfilesFile(
		JSON.parse(profilesText({ team: CONFIG }, { active: "missing" })),
	);
	assert.equal(normalized?.file.active, undefined);
	assert.equal(normalized?.drops.droppedProfiles.length, 0);
});

test("normalizeProfilesFile accepts effort as alias for thinking in profile entries (#1403)", () => {
	const normalized = normalizeProfilesFile(
		JSON.parse(
			profilesText({
				hybrid: {
					"example-agent": { model: "anthropic/claude-sonnet-4", effort: "medium" },
					"worker": { effort: "high" },
				},
			}),
		),
	);
	assert.deepEqual(normalized?.file.profiles.hybrid, {
		"example-agent": { model: "anthropic/claude-sonnet-4", thinking: "medium" },
		"worker": { model: undefined, thinking: "high" },
	});
	assert.equal(normalized?.drops.droppedAgents.length, 0);
});

test("bootstrapProfilesFile seeds a current profile, active only when routing is non-empty", () => {
	const empty = bootstrapProfilesFile({});
	assert.deepEqual(empty, {
		kind: PROFILES_KIND,
		version: PROFILES_VERSION,
		active: undefined,
		profiles: { current: {} },
	});
	const seeded = bootstrapProfilesFile(CONFIG);
	assert.deepEqual(seeded, {
		kind: PROFILES_KIND,
		version: PROFILES_VERSION,
		active: "current",
		profiles: { current: CONFIG },
	});
	const config: AgentModelConfig = structuredClone(CONFIG);
	bootstrapProfilesFile(config);
	assert.deepEqual(config, CONFIG);
});

test("buildProfileListItems shows the name, active marker, and role count", () => {
	let file = createProfile(emptyProfilesFile(), "team", CONFIG);
	file = createProfile(file, "idle", {});
	file = setActiveProfile(file, "team");
	assert.deepEqual(buildProfileListItems(file), [
		{ id: "team", label: "team (active)", description: "2 roles" },
		{ id: "idle", label: "idle", description: "0 roles" },
	]);
});

test("formatProfileSummaryLines renders counts, models, and roles", () => {
	assert.deepEqual(
		formatProfileSummaryLines({
			models: [
				{ model: "a/one", count: 3, roles: ["delta", "echo", "gamma"] },
				{ model: "b/two", count: 1, roles: ["alpha"] },
			],
			total: 4,
		}),
		[
			"3 agents → a/one: delta, echo, gamma",
			"1 agent → b/two: alpha",
		],
	);
	assert.deepEqual(formatProfileSummaryLines({ models: [], total: 0 }), [
		"No routing entries — every agent inherits its default model.",
	]);
});

// ---- Triangulation: adversarial and alternate cases ----

test("parseProfilesFileText drops a __proto__ profile key without polluting the object", () => {
	const text = '{"kind":"gentle-pi.agent_model_profiles","version":1,"profiles":{"__proto__":{"explore":{"model":"m/x"}},"team":{"explore":{"model":"m/x"}}}}';
	const parsed = parseProfilesFileText(text);
	assert.equal(parsed.status, "valid");
	if (parsed.status !== "valid") return;
	assert.deepEqual(Object.keys(parsed.file.profiles), ["team"]);
	assert.equal(({} as Record<string, unknown>).explore, undefined);
	assert.equal(Object.getPrototypeOf(parsed.file.profiles), Object.prototype);
});

test("serialize then parse is idempotent across repeated round-trips", () => {
	let file = createProfile(emptyProfilesFile(), "team", CONFIG);
	file = setActiveProfile(file, "team");
	const first = serializeProfilesFile(file);
	const reparsed = parseProfilesFileText(first);
	assert.equal(reparsed.status, "valid");
	if (reparsed.status !== "valid") return;
	assert.equal(serializeProfilesFile(reparsed.file), first);
});

test("deleteProfile removes the last profile and leaves a valid empty store", () => {
	const file = createProfile(emptyProfilesFile(), "team", CONFIG);
	const next = deleteProfile(file, "team");
	assert.deepEqual(next.profiles, {});
	assert.equal(next.active, undefined);
	assert.deepEqual(parseProfilesFileText(serializeProfilesFile(next)), {
		status: "valid",
		file: next,
	});
});

test("profile names accept slug punctuation but reject unicode letters", () => {
	assert.equal(isValidProfileName("a.b-c_d"), true);
	assert.equal(isValidProfileName("café"), false);
	assert.equal(isValidProfileName("1up"), true);
});

test("summarizeProfile breaks count ties by model name ascending", () => {
	const summary = summarizeProfile({
		one: { model: "z/last" },
		two: { model: "a/first" },
	});
	assert.deepEqual(
		summary.models.map((model) => model.model),
		["a/first", "z/last"],
	);
});

test("duplicateProfile deep-clones so copy edits cannot leak into the source", () => {
	const file = createProfile(emptyProfilesFile(), "team", CONFIG);
	const next = duplicateProfile(file, "team", "copy");
	const copyEntry = next.profiles.copy.explore;
	if (!copyEntry) throw new Error("copy entry missing");
	copyEntry.model = "changed";
	assert.equal(file.profiles.team.explore?.model, "openai-codex/gpt-5.6-terra");
});

test("renameProfile preserves the profile order in the store", () => {
	let file = createProfile(emptyProfilesFile(), "alpha", {});
	file = createProfile(file, "beta", CONFIG);
	const next = renameProfile(file, "alpha", "delta");
	assert.deepEqual(Object.keys(next.profiles), ["delta", "beta"]);
});

test("an empty profile exports and imports cleanly", () => {
	const text = serializeProfileExport("empty", {});
	assert.deepEqual(parseProfileExportTextWithDrops(text), {
		name: "empty",
		config: {},
		droppedAgents: [],
	});
});

test("normalizeProfilesFile reports an active marker that names no profile", () => {
	const normalized = normalizeProfilesFile({
		kind: PROFILES_KIND,
		version: PROFILES_VERSION,
		active: "gone",
		profiles: { team: CONFIG },
	});
	assert.equal(normalized?.file.active, undefined);
	assert.equal(normalized?.drops.droppedActive, "gone");
});

// ---- Filesystem wrappers ----
//
// These two wrappers are the only part of the module that touches disk, so they
// run against a real temporary directory instead of a mock: the atomic replace
// cannot be proven without a filesystem, and the failure modes that matter here
// (absent file, unreadable JSON, dropped entries, missing parent directories) are
// exactly the ones a mock would hide.

const root = mkdtempSync(join(tmpdir(), "gentle-agent-profiles-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("readProfilesFileResult reports a missing store without throwing", () => {
	assert.deepEqual(readProfilesFileResult(join(root, "absent.json")), { status: "missing" });
});

test("readProfilesFileResult reports malformed JSON as invalid", () => {
	const path = join(root, "malformed.json");
	writeFileSync(path, "{ not json");
	assert.deepEqual(readProfilesFileResult(path), { status: "invalid" });
});

test("readProfilesFileResult rejects a foreign kind or version", () => {
	const path = join(root, "foreign.json");
	writeFileSync(path, JSON.stringify({ kind: "other", version: 1, profiles: {} }));
	assert.deepEqual(readProfilesFileResult(path), { status: "invalid" });
});

test("readProfilesFileResult returns normalized profiles together with their drops", () => {
	const path = join(root, "drops.json");
	writeFileSync(
		path,
		JSON.stringify({
			kind: PROFILES_KIND,
			version: PROFILES_VERSION,
			active: "missing-profile",
			profiles: { team: CONFIG, "bad name": CONFIG },
		}),
	);
	const result = readProfilesFileResult(path);
	if (result.status !== "valid") throw new Error(`expected valid, got ${result.status}`);
	assert.deepEqual(Object.keys(result.file.profiles), ["team"]);
	assert.equal(result.file.active, undefined);
	assert.deepEqual(result.drops.droppedProfiles, ["bad name"]);
	assert.equal(result.drops.droppedActive, "missing-profile");
});

test("writeProfilesFileSync creates missing parent directories", () => {
	const path = join(root, "nested", "deeper", "profiles.json");
	writeProfilesFileSync(path, createProfile(emptyProfilesFile(), "team", CONFIG));
	assert.equal(readProfilesFileResult(path).status, "valid");
});

// The profiles store and the per-repository profile pin both replace their file
// through this helper, so the interruption guarantee belongs to the helper and not
// to one store's serializer.
test("writeJsonFileAtomicallySync writes exact bytes, creates parents, and leaves no temp file behind", () => {
	const path = join(root, "atomic-text", "artifact.json");
	const first = `${JSON.stringify({ kind: "gentle-pi.test", value: 1 }, null, 2)}\n`;
	writeJsonFileAtomicallySync(path, first);
	assert.equal(readFileSync(path, "utf8"), first);
	writeJsonFileAtomicallySync(path, "second\n");
	assert.equal(readFileSync(path, "utf8"), "second\n");
	assert.deepEqual(readdirSync(join(root, "atomic-text")).filter((entry) => entry.includes(".tmp")), []);
});

test("writeJsonFileAtomicallySync skips an identical rewrite so the file is not replaced", () => {
	const path = join(root, "atomic-noop", "artifact.json");
	const text = `${JSON.stringify({ kind: "gentle-pi.test", value: 1 }, null, 2)}\n`;
	writeJsonFileAtomicallySync(path, text);
	const historicalTime = new Date("2000-01-01T00:00:00.000Z");
	utimesSync(path, historicalTime, historicalTime);
	const first = statSync(path).mtimeMs;
	writeJsonFileAtomicallySync(path, text);
	const skipped = statSync(path).mtimeMs;
	assert.equal(readFileSync(path, "utf8"), text);
	assert.equal(skipped, first, "an identical rewrite leaves the file untouched");
	writeJsonFileAtomicallySync(path, "changed\n");
	assert.notEqual(statSync(path).mtimeMs, skipped, "a changed rewrite still replaces the file");
});

test("writeProfilesFileSync replaces the store and leaves no temp file behind", () => {
	const path = join(root, "atomic.json");
	const first = createProfile(emptyProfilesFile(), "alpha", CONFIG);
	writeProfilesFileSync(path, first);
	writeProfilesFileSync(path, createProfile(first, "beta", CONFIG));
	const round = readProfilesFileResult(path);
	if (round.status !== "valid") throw new Error(`expected valid, got ${round.status}`);
	assert.deepEqual(Object.keys(round.file.profiles), ["alpha", "beta"]);
	assert.deepEqual(readdirSync(root).filter((entry) => entry.includes(".tmp")), []);
});

test("writeProfilesFileSync reports the operation error and still removes the temp file", () => {
	const occupied = join(root, "occupied");
	mkdirSync(occupied, { recursive: true });
	assert.throws(() =>
		writeProfilesFileSync(occupied, createProfile(emptyProfilesFile(), "team", CONFIG)),
	);
	assert.deepEqual(readdirSync(root).filter((entry) => entry.includes(".tmp")), []);
});

test("writeProfilesFileSync reports a serialization failure, skips the rename, and cleans up", () => {
	// The write path fails before the rename, so this proves the reported error is
	// the operation's, that the destination is never touched once a failure is
	// recorded, and that cleanup still runs.
	const path = join(root, "serialize.json");
	const file = createProfile(emptyProfilesFile(), "team", CONFIG);
	const circular: Record<string, unknown> = {};
	circular.self = circular;
	(file.profiles.team as Record<string, unknown>).explore = circular;
	assert.throws(() => writeProfilesFileSync(path, file), /circular/i);
	assert.equal(existsSync(path), false);
	assert.deepEqual(readdirSync(root).filter((entry) => entry.includes(".tmp")), []);
});

test("the path helpers resolve both stores inside the config home", () => {
	const home = join(root, "config-home");
	assert.equal(profilesFilePath(home), join(home, "profiles.json"));
	assert.equal(profileExportPath(home), join(home, "profiles.export.json"));
});

test("the orchestrator key is never counted or listed as an agent role", () => {
	const config: AgentModelConfig = {
		[PROFILE_ORCHESTRATOR_KEY]: { model: "nan/glm5.3", thinking: "high" },
		alpha: { model: "a/one" },
		beta: { model: "a/one" },
	};
	assert.deepEqual(summarizeProfile(config), {
		models: [{ model: "a/one", count: 2, roles: ["alpha", "beta"] }],
		total: 2,
	});
	const file = createProfile(emptyProfilesFile(), "team", config);
	assert.deepEqual(buildProfileListItems(file).map((item) => item.description), ["2 roles"]);
	assert.deepEqual(profileRoleEntries(config).map(([name]) => name), ["alpha", "beta"]);
	assert.deepEqual(readProfileOrchestrator(config), { model: "nan/glm5.3", thinking: "high" });
});

test("the orchestrator helper treats an absent or empty entry as undefined", () => {
	assert.equal(readProfileOrchestrator({}), undefined);
	assert.equal(readProfileOrchestrator({ alpha: { model: "a/one" } }), undefined);
	assert.equal(readProfileOrchestrator({ [PROFILE_ORCHESTRATOR_KEY]: {} }), undefined);
});

test("profileRoutingRows lists one aligned row per agent, in a stable order", () => {
	const rows = profileRoutingRows({
		[PROFILE_ORCHESTRATOR_KEY]: { model: "nan/glm5.3" },
		zeta: { model: "nan/deepseek-v4-flash", thinking: "high" },
		alpha: { thinking: "high" },
		mid: { model: "nan/qwen3.8-flash" },
	});
	assert.deepEqual(rows, [
		{ agent: "alpha", model: "inherit", thinking: "high" },
		{ agent: "mid", model: "nan/qwen3.8-flash", thinking: "inherit" },
		{ agent: "zeta", model: "nan/deepseek-v4-flash", thinking: "high" },
	]);
	assert.deepEqual(profileRoutingRows({}), []);

	const widths = routingColumnWidths(rows, [{ agent: "a-much-longer-agent-name", model: "m/x", thinking: "low" }]);
	assert.deepEqual(widths, { agent: "a-much-longer-agent-name".length, model: "nan/deepseek-v4-flash".length });
	assert.equal(
		formatRoutingRow(rows[0], widths),
		`${"alpha".padEnd(widths.agent)}  ${"inherit".padEnd(widths.model)}  high`,
	);
	assert.equal(
		formatRoutingRow(rows[2], widths),
		`${"zeta".padEnd(widths.agent)}  ${"nan/deepseek-v4-flash".padEnd(widths.model)}  high`,
	);
});

test("formatOrchestratorSelection separates set, inherit, and inherit-with-thinking", () => {
	assert.equal(formatOrchestratorSelection(undefined), "inherit");
	assert.equal(formatOrchestratorSelection({ thinking: "high" }), "inherit · high");
	assert.equal(formatOrchestratorSelection({ model: "nan/glm5.3" }), "nan/glm5.3");
	assert.equal(
		formatOrchestratorSelection({ model: "nan/glm5.3", thinking: "max" }),
		"nan/glm5.3 · max",
	);
});
