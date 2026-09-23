import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applySavedModelConfig, readModelConfig, readModelConfigAsync } from "../extensions/gentle-ai.ts";

test("model routing authority normalizes and preserves sync/async source status", async (t) => {
	const loaded = await import("../lib/model-routing-authority.ts").then(
		(module) => ({ module, error: undefined }),
		(error) => ({ module: undefined, error }),
	);
	assert.ok(
		loaded.module,
		`shared model routing authority must load: ${String(loaded.error)}`,
	);
	const authority = loaded.module;
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-model-routing-authority-"));
	const globalDir = join(root, "global");
	const projectDir = join(root, "project");
	const projectConfigDir = join(projectDir, ".pi", "gentle-ai");
	const agentsDir = join(root, "agents");
	mkdirSync(globalDir, { recursive: true });
	mkdirSync(projectConfigDir, { recursive: true });
	mkdirSync(agentsDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	assert.equal(authority.normalizeModelId(" openai/gpt-5 "), "openai/gpt-5");
	assert.equal(authority.normalizeModelId("bad model"), undefined);
	assert.deepEqual(authority.normalizeRoutingEntry(" inherit "), { model: "inherit" });
	assert.deepEqual(
		authority.normalizeRoutingEntry({ model: " anthropic/opus ", thinking: "high" }),
		{ model: "anthropic/opus", thinking: "high" },
	);
	assert.deepEqual(authority.normalizeRoutingEntry(null), undefined);
	assert.deepEqual(
		authority.normalizeModelConfig({
			worker: " openai/gpt-5 ",
			clear: {},
			"not valid": "ignored",
			nullValue: null,
		}),
		{ worker: { model: "openai/gpt-5" }, clear: {} },
	);

	const missingPath = join(globalDir, "missing.json");
	assert.deepEqual(authority.readModelConfigFile(missingPath), { status: "missing" });
	assert.deepEqual(await authority.readModelConfigFileAsync(missingPath), { status: "missing" });

	const validGlobalPath = join(globalDir, "valid.json");
	writeFileSync(
		validGlobalPath,
		JSON.stringify({ worker: "openai/gpt-5", reviewer: { thinking: "medium" }, "not valid": "openai/gpt-4" }),
	);
	const validSync = authority.readModelConfigFile(validGlobalPath);
	const validAsync = await authority.readModelConfigFileAsync(validGlobalPath);
	assert.deepEqual(validSync, {
		status: "valid",
		config: {
			worker: { model: "openai/gpt-5" },
			reviewer: { model: undefined, thinking: "medium" },
			"not valid": { model: "openai/gpt-4" },
		},
	});
	assert.deepEqual(validAsync, validSync);

	const invalidGlobalPath = join(globalDir, "invalid.json");
	writeFileSync(invalidGlobalPath, "[]");
	assert.deepEqual(authority.readModelConfigFile(invalidGlobalPath), {
		status: "invalid",
		path: invalidGlobalPath,
	});
	assert.deepEqual(await authority.readModelConfigFileAsync(invalidGlobalPath), {
		status: "invalid",
		path: invalidGlobalPath,
	});

	const projectPath = join(projectConfigDir, "models.json");
	writeFileSync(projectPath, JSON.stringify({ project: "google/gemini" }));
	assert.deepEqual(
		authority.readSavedModelConfig(missingPath, projectPath),
		{ status: "valid", config: { project: { model: "google/gemini" } } },
	);
	assert.deepEqual(
		await authority.readSavedModelConfigAsync(missingPath, projectPath),
		await authority.readSavedModelConfig(missingPath, projectPath),
	);
	assert.deepEqual(authority.readSavedModelConfig(invalidGlobalPath, projectPath), {
		status: "invalid",
		path: invalidGlobalPath,
	});
	assert.deepEqual(await authority.readSavedModelConfigAsync(invalidGlobalPath, projectPath), {
		status: "invalid",
		path: invalidGlobalPath,
	});

	const sourceCases = [
		[missingPath, missingPath, { status: "missing" }],
		[missingPath, projectPath, { status: "valid", config: { project: { model: "google/gemini" } } }],
		[validGlobalPath, projectPath, validSync],
		[missingPath, invalidGlobalPath, { status: "invalid", path: invalidGlobalPath }],
		[invalidGlobalPath, projectPath, { status: "invalid", path: invalidGlobalPath }],
	] as const;
	for (const [globalSource, projectSource, expected] of sourceCases) {
		assert.deepEqual(authority.readSavedModelConfig(globalSource, projectSource), expected);
		assert.deepEqual(await authority.readSavedModelConfigAsync(globalSource, projectSource), expected);
	}

	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = globalDir;
	t.after(() => {
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
	});
	writeFileSync(projectPath, JSON.stringify({ project: "google/gemini" }));
	assert.deepEqual(readModelConfig(projectDir), { project: { model: "google/gemini" } });
	assert.deepEqual(await readModelConfigAsync(projectDir), readModelConfig(projectDir));

	writeFileSync(projectPath, "[]");
	assert.deepEqual(authority.readModelConfigFile(projectPath), { status: "invalid", path: projectPath });
	assert.deepEqual(await authority.readModelConfigFileAsync(projectPath), { status: "invalid", path: projectPath });
	assert.deepEqual(readModelConfig(projectDir), {});
	assert.deepEqual(await readModelConfigAsync(projectDir), {});

	writeFileSync(join(globalDir, "models.json"), JSON.stringify({ global: "openai/gpt-5" }));
	assert.deepEqual(readModelConfig(projectDir), { global: { model: "openai/gpt-5" } });
	assert.deepEqual(await readModelConfigAsync(projectDir), readModelConfig(projectDir));

	writeFileSync(join(globalDir, "models.json"), "[]");
	assert.deepEqual(readModelConfig(projectDir), {});
	assert.deepEqual(await readModelConfigAsync(projectDir), {});
});

test("saved-routing apply fails closed for invalid project and global sources", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-model-routing-apply-"));
	const configHome = join(root, "global");
	const projectConfigDir = join(root, ".pi", "gentle-ai");
	const projectAgentsDir = join(root, ".pi", "agents");
	const projectProfileDir = join(root, ".pi");
	const agentHome = join(root, "agent-home");
	const agentHomeAgentsDir = join(agentHome, "agents");
	const agentHomeSubagentsDir = join(agentHome, "subagents");
	mkdirSync(configHome, { recursive: true });
	mkdirSync(projectConfigDir, { recursive: true });
	mkdirSync(projectAgentsDir, { recursive: true });
	mkdirSync(projectProfileDir, { recursive: true });
	mkdirSync(agentHomeAgentsDir, { recursive: true });
	mkdirSync(agentHomeSubagentsDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	t.after(() => {
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	});

	const agentPath = join(projectAgentsDir, "worker.md");
	writeFileSync(agentPath, "---\nname: worker\ndescription: Worker\n---\nbody\n");
	const profilePath = join(projectProfileDir, "subagents.json");
	const profileBytes = JSON.stringify({
		unrelated: { keep: true },
		model_profiles: { worker: { model: "existing/model", effort: "low" } },
	}, null, 2) + "\n";
	writeFileSync(profilePath, profileBytes);
	const context = { cwd: root } as Parameters<typeof applySavedModelConfig>[0];
	const projectPath = join(projectConfigDir, "models.json");
	const globalPath = join(configHome, "models.json");
	let mutatorCalls = 0;
	const applyConfig = async () => {
		mutatorCalls += 1;
		return { updated: 0, skipped: 0 };
	};

	for (const projectValue of ["{", "[]", "null"] as const) {
		writeFileSync(projectPath, projectValue);
		const before = statSync(profilePath);
		const result = await applySavedModelConfig(context, applyConfig);
		assert.deepEqual(result, { updated: 0, skipped: 0, invalidPath: projectPath });
		assert.equal(mutatorCalls, 0);
		assert.equal(readFileSync(profilePath, "utf8"), profileBytes);
		assert.equal(statSync(profilePath).mtimeMs, before.mtimeMs);
	}

	writeFileSync(globalPath, "[]");
	writeFileSync(projectPath, JSON.stringify({ worker: "new/model" }));
	const before = statSync(profilePath);
	const result = await applySavedModelConfig(context, applyConfig);
	assert.deepEqual(result, { updated: 0, skipped: 0, invalidPath: globalPath });
	assert.equal(mutatorCalls, 0);
	assert.equal(readFileSync(profilePath, "utf8"), profileBytes);
	assert.equal(statSync(profilePath).mtimeMs, before.mtimeMs);
});

test("saved-routing apply preserves missing, valid, null, inherit, and omission behavior", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-model-routing-apply-valid-"));
	const configHome = join(root, "global");
	const projectConfigDir = join(root, ".pi", "gentle-ai");
	const projectAgentsDir = join(root, ".pi", "agents");
	const projectProfileDir = join(root, ".pi");
	const agentHome = join(root, "agent-home");
	const agentHomeAgentsDir = join(agentHome, "agents");
	const agentHomeSubagentsDir = join(agentHome, "subagents");
	mkdirSync(configHome, { recursive: true });
	mkdirSync(projectConfigDir, { recursive: true });
	mkdirSync(projectAgentsDir, { recursive: true });
	mkdirSync(projectProfileDir, { recursive: true });
	mkdirSync(agentHomeAgentsDir, { recursive: true });
	mkdirSync(agentHomeSubagentsDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	t.after(() => {
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	});

	const agentPath = join(projectAgentsDir, "worker.md");
	writeFileSync(agentPath, "---\nname: worker\ndescription: Worker\n---\nbody\n");
	const profilePath = join(projectProfileDir, "subagents.json");
	const initialProfile = {
		unrelated: { keep: true },
		model_profiles: { worker: { model: "existing/model", effort: "low" } },
	};
	writeFileSync(profilePath, `${JSON.stringify(initialProfile, null, 2)}\n`);
	const context = { cwd: root } as Parameters<typeof applySavedModelConfig>[0];
	const projectPath = join(projectConfigDir, "models.json");

	const missing = await applySavedModelConfig(context);
	assert.equal(missing.invalidPath, undefined);
	assert.deepEqual(JSON.parse(readFileSync(profilePath, "utf8")), initialProfile);

	writeFileSync(projectPath, JSON.stringify({ worker: "inherit" }));
	const valid = await applySavedModelConfig(context);
	assert.equal(valid.invalidPath, undefined);
	const validProfile = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, any>;
	assert.deepEqual(validProfile.unrelated, initialProfile.unrelated);
	assert.deepEqual(validProfile.model_profiles.worker, { model: "inherit" });
	assert.match(readFileSync(agentPath, "utf8"), /model: inherit\n/);
	assert.doesNotMatch(readFileSync(agentPath, "utf8"), /thinking:/);

	const afterValidBytes = readFileSync(profilePath, "utf8");
	const afterValid = statSync(profilePath);
	writeFileSync(projectPath, JSON.stringify({ worker: null }));
	const nullEntry = await applySavedModelConfig(context);
	assert.equal(nullEntry.invalidPath, undefined);
	assert.equal(readFileSync(profilePath, "utf8"), afterValidBytes);
	assert.equal(statSync(profilePath).mtimeMs, afterValid.mtimeMs);
	assert.doesNotMatch(readFileSync(agentPath, "utf8"), /model: null/);

	let mutatorCalls = 0;
	const applyConfig = async () => {
		mutatorCalls += 1;
		return { updated: 0, skipped: 0 };
	};
	writeFileSync(projectPath, JSON.stringify({ worker: "new/model" }));
	const injected = await applySavedModelConfig(context, applyConfig);
	assert.equal(injected.invalidPath, undefined);
	assert.equal(mutatorCalls, 1);
});
