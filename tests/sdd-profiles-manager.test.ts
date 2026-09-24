import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Profile } from "../lib/sdd-profiles-catalog.ts";
import {
	applyProfileToConfig,
	applyProfileToFile,
	extractProfileFromConfig,
	resolveAvailableModels,
	sanitizeProfileName,
	SddProfileManager,
} from "../lib/sdd-profiles-manager.ts";

const PROFILE: Profile = {
	name: "test-profile",
	description: "Test profile",
	default_model: "anthropic/claude-sonnet-5",
	default_effort: "medium",
	model_profiles: {
		"sdd-explore": { model: "openai/gpt-5-mini", effort: "low" },
		"sdd-spec": { model: "anthropic/claude-sonnet-5", effort: "high" },
	},
};

test("apply preserves custom props and updates model_profiles", () => {
	const current = {
		timeout: 5000,
		tools: ["read"],
		default_model: "old/model",
		model_profiles: { "sdd-explore": { model: "old/model" } },
	};
	const next = applyProfileToConfig(current, PROFILE);
	assert.equal(next.timeout, 5000);
	assert.deepEqual(next.tools, ["read"]);
	assert.equal(next.default_model, "anthropic/claude-sonnet-5");
	assert.equal(next.default_effort, "medium");
	assert.equal(next.active_profile, "test-profile");
	assert.deepEqual(next.model_profiles, PROFILE.model_profiles);
	assert.notEqual(next.model_profiles, PROFILE.model_profiles);
});

test("apply without defaults leaves existing defaults alone", () => {
	const profile: Profile = { name: "bare", model_profiles: {} };
	const next = applyProfileToConfig({ default_model: "keep/me" }, profile);
	assert.equal(next.default_model, "keep/me");
	assert.equal(next.default_effort, undefined);
	assert.equal(next.active_profile, "bare");
});

test("extract round-trips config data", () => {
	const config = applyProfileToConfig({ custom: true }, PROFILE);
	const extracted = extractProfileFromConfig(config, "round-trip");
	assert.equal(extracted.name, "round-trip");
	assert.equal(extracted.default_model, PROFILE.default_model);
	assert.equal(extracted.default_effort, PROFILE.default_effort);
	assert.deepEqual(extracted.model_profiles, PROFILE.model_profiles);
	const reapplied = applyProfileToConfig({}, extracted);
	assert.deepEqual(reapplied.model_profiles, PROFILE.model_profiles);
});

test("extract skips entries without a model string", () => {
	const extracted = extractProfileFromConfig(
		{ model_profiles: { good: { model: "a/b" }, bad: {} } },
		"partial",
		"desc",
	);
	assert.deepEqual(extracted.model_profiles, { good: { model: "a/b", effort: undefined } });
	assert.equal(extracted.description, "desc");
});

test("applyToFile writes valid JSON to a tmp dir", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-profile-"));
	const filePath = path.join(dir, "sub", "subagents.json");
	const returned = applyProfileToFile(filePath, PROFILE);
	const onDisk = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	assert.deepEqual(onDisk, returned);
	assert.equal(onDisk.active_profile, "test-profile");
	assert.deepEqual(onDisk.model_profiles, PROFILE.model_profiles);
	const leftovers = fs.readdirSync(path.join(dir, "sub")).filter((f) => f.endsWith(".tmp"));
	assert.deepEqual(leftovers, []);
});

test("applyToFile preserves custom props already on disk", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-profile-"));
	const filePath = path.join(dir, "subagents.json");
	fs.writeFileSync(filePath, JSON.stringify({ timeout: 9000, tools: ["x"] }));
	const next = applyProfileToFile(filePath, PROFILE);
	assert.equal(next.timeout, 9000);
	assert.deepEqual(next.tools, ["x"]);
});

test("sanitize normalizes names", () => {
	assert.equal(sanitizeProfileName("  My Profile! "), "my-profile-");
	assert.equal(sanitizeProfileName("UPPER_under-score"), "upper_under-score");
	assert.equal(sanitizeProfileName("a/b c"), "a-b-c");
});

function makeManagerDirs() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-mgr-"));
	const globalDir = path.join(root, "global");
	const projectDir = path.join(root, "project");
	const builtinsDir = path.join(root, "builtins");
	fs.mkdirSync(globalDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(builtinsDir, { recursive: true });
	return {
		root,
		globalDir,
		projectDir,
		builtinsDir,
		activeStatePath: path.join(root, ".active"),
		globalSubagentsPath: path.join(root, "global-subagents.json"),
		projectSubagentsPath: path.join(root, "project-subagents.json"),
	};
}

function writeProfile(dir: string, profile: Profile): void {
	fs.writeFileSync(path.join(dir, `${profile.name}.json`), JSON.stringify(profile));
}

const MIN_PROFILE = (name: string, model = "a/b"): Profile => ({ name, model_profiles: { x: { model } } });

test("listProfiles includes embedded builtins", () => {
	const d = makeManagerDirs();
	const mgr = new SddProfileManager({ ...d });
	const names = new Map(mgr.listProfiles().map((p) => [p.name, p]));
	assert.ok(names.has("gentle-default"));
	assert.equal(names.get("gentle-default")?.scope, "builtin");
	assert.equal(names.get("gentle-default")?.is_active, false);
});

test("listProfiles precedence is project over global over builtin", () => {
	const d = makeManagerDirs();
	writeProfile(d.globalDir, { ...MIN_PROFILE("gentle-default"), default_model: "global/m" });
	writeProfile(d.projectDir, { ...MIN_PROFILE("gentle-default"), default_model: "project/m" });
	const mgr = new SddProfileManager({ ...d });
	const found = mgr.listProfiles().find((p) => p.name === "gentle-default");
	assert.equal(found?.scope, "project");
	assert.equal(found?.default_model, "project/m");
});

test("listProfiles hides tombstoned builtin", () => {
	const d = makeManagerDirs();
	fs.writeFileSync(path.join(d.globalDir, ".deleted-profiles"), "gentle-default\n");
	const mgr = new SddProfileManager({ ...d });
	assert.ok(!mgr.listProfiles().some((p) => p.name === "gentle-default"));
	assert.equal(mgr.loadProfile("gentle-default"), null);
});

test("loadProfile falls back project, global, builtinsDir, embedded", () => {
	const d = makeManagerDirs();
	writeProfile(d.builtinsDir, { ...MIN_PROFILE("custom"), default_model: "builtins/m" });
	const mgr = new SddProfileManager({ ...d });
	assert.equal(mgr.loadProfile("custom")?.default_model, "builtins/m");
	writeProfile(d.globalDir, { ...MIN_PROFILE("custom"), default_model: "global/m" });
	assert.equal(mgr.loadProfile("custom")?.default_model, "global/m");
	writeProfile(d.projectDir, { ...MIN_PROFILE("custom"), default_model: "project/m" });
	assert.equal(mgr.loadProfile("custom")?.default_model, "project/m");
	assert.equal(mgr.loadProfile("gentle-economy")?.name, "gentle-economy");
	assert.equal(mgr.loadProfile("missing"), null);
});

test("getActiveProfileName prefers project subagents.json over .active file", () => {
	const d = makeManagerDirs();
	fs.writeFileSync(d.activeStatePath, "from-active\n");
	fs.writeFileSync(d.projectSubagentsPath, JSON.stringify({ active_profile: "from-project" }));
	const mgr = new SddProfileManager({ ...d });
	assert.equal(mgr.getActiveProfileName(), "from-project");
	fs.unlinkSync(d.projectSubagentsPath);
	assert.equal(mgr.getActiveProfileName(), "from-active");
	fs.unlinkSync(d.activeStatePath);
	assert.equal(mgr.getActiveProfileName(), null);
});

test("resolveAvailableModels merges registry discovery with fallback", async () => {
	const ctx = {
		modelRegistry: {
			getAvailable: async () => [
				{ provider: "acme", id: "model-a" },
				{ providerId: "other", model: "model-b" },
			],
		},
	};
	const models = await resolveAvailableModels(ctx);
	assert.ok(models.includes("acme/model-a"));
	assert.ok(models.includes("other/model-b"));
	assert.ok(models.includes("openai/gpt-4o"));
	assert.deepEqual(models, [...models].sort((a, b) => a.localeCompare(b)));
});
