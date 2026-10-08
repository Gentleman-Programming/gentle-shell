import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { __testing, applyModelConfig, applyModelConfigAsync, applySavedModelConfig, readModelConfig, readModelConfigAsync } from "../extensions/gentle-ai.ts";

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
	assert.deepEqual(
		authority.normalizeRoutingEntry({ model: "anthropic/opus", effort: "high" }),
		{ model: "anthropic/opus", thinking: "high" },
	);
	assert.deepEqual(
		authority.normalizeRoutingEntry({ effort: "medium" }),
		{ model: undefined, thinking: "medium" },
	);
	assert.deepEqual(
		authority.normalizeRoutingEntry({ model: "anthropic/opus", thinking: "high", effort: "low" }),
		{ model: "anthropic/opus", thinking: "high" },
	);
	assert.deepEqual(
		authority.normalizeRoutingEntry({ model: "anthropic/opus", effort: "invalid" }),
		{ model: "anthropic/opus", thinking: undefined },
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

for (const mode of ["sync", "async", "saved"] as const) {
	test(`${mode} routing leaves retired SDD identities and historical ownership untouched`, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "gentle-pi-retired-routing-"));
		const home = join(root, "home");
		const agentHome = join(home, ".pi", "agent");
		const project = join(root, "project");
		const configHome = join(home, ".pi", "gentle-ai");
		const overrides = {
			HOME: home,
			GENTLE_PI_AGENT_HOME: agentHome,
			PI_CODING_AGENT_DIR: agentHome,
			GENTLE_PI_CONFIG_HOME: configHome,
		};
		const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
		Object.assign(process.env, overrides);
		t.after(() => {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		});
		const put = (path: string, bytes: string) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, bytes);
		};
		const agent = (name: string, packageName?: string) =>
			`---\nname: ${name}\n${packageName ? `package: ${packageName}\n` : ""}description: Fixture\nmodel: old/model\nthinking: low\n---\nPersonal body\n`;
		const roots = [
			join(agentHome, "agents"),
			join(agentHome, "subagents"),
			join(home, ".agents"),
			join(project, ".agents"),
			join(project, ".pi", "agents"),
			join(project, ".pi", "subagents"),
			...["pi-subagents-j0k3r", "pi-subagents"].flatMap((pkg) => [
				join(project, ".pi", "npm", "node_modules", pkg, "agents"),
				join(home, ".local", "lib", "node_modules", pkg, "agents"),
			]),
		];
		roots.push(join(agentHome, "agents", "dotted"), join(project, ".pi", "agents", "dotted"));
		const retiredNames = ["sdd-research", "sdd-apply", "sdd", "sdd-design", "sdd-spec",
			"sdd-reserved-future", "sdd-verify", "sdd-tasks", "sdd-explore", "sdd-archive",
			"sdd-legacy.worker", "sdd-legacy.worker"];
		const preserved = new Map<string, Buffer>();
		const config: Parameters<typeof applyModelConfig>[1] = {};
		const oldProfiles: Record<string, { model: string; effort: string }> = {};
		for (const [index, dir] of roots.entries()) {
			const name = retiredNames[index];
			const packageName = index % 2 ? "legacy.package" : undefined;
			const identity = packageName ? `${packageName}.${name}` : name;
			// Neutral filenames force discovery to use frontmatter identity.
			const path = join(dir, index === 0 ? "sdd-research.md" : "personal.md");
			put(path, agent(name, packageName));
			preserved.set(path, readFileSync(path));
			config[identity] = { model: "new/model", thinking: "high" };
			oldProfiles[identity] = { model: "old/model", effort: "low" };
		}
		const modifiedPath = join(roots[0], "sdd-apply.md");
		const original = agent("sdd-apply");
		put(modifiedPath, `${original}User edits\n`);
		preserved.set(modifiedPath, readFileSync(modifiedPath));
		config["sdd-apply"] = { model: "new/model" };
		oldProfiles["sdd-apply"] = { model: "old/model", effort: "low" };
		for (const name of ["sdd-orphan", "legacy.package.sdd-orphan", "legacy.package.sdd",
			"sdd-missing.worker", "legacy.package.sdd-missing.worker"]) {
			config[name] = {};
			oldProfiles[name] = { model: "old/orphan", effort: "medium" };
		}
		const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
		const manifestPath = join(agentHome, "gentle-ai", "managed-assets.json");
		put(manifestPath, JSON.stringify({ schemaVersion: 1, assets: {
			"agents/sdd-research.md": hash(readFileSync(join(roots[0], "sdd-research.md"))),
			"agents/sdd-apply.md": hash(original),
			"agents/sdd-missing.md": hash("historical missing file"),
		} }, null, 2) + "\n");
		preserved.set(manifestPath, readFileSync(manifestPath));
		const profilePaths = [join(agentHome, "subagents.json"), join(project, ".pi", "subagents.json")];
		const initialProfiles = { unrelated: { keep: true }, model_profiles: oldProfiles };
		for (const path of profilePaths) put(path, JSON.stringify(initialProfiles, null, 2) + "\n");
		const savedPaths = [join(configHome, "models.json"), join(project, ".pi", "gentle-ai", "models.json")];
		const apply = async () => {
			for (const path of savedPaths) {
				put(path, JSON.stringify(config, null, 2) + "\n");
				preserved.set(path, readFileSync(path));
			}
			if (mode === "sync") return applyModelConfig(project, config);
			if (mode === "async") return applyModelConfigAsync(project, config);
			return applySavedModelConfig({ cwd: project } as Parameters<typeof applySavedModelConfig>[0]);
		};
		const assertPreserved = () => {
			for (const [path, bytes] of preserved) assert.deepEqual(readFileSync(path), bytes, path);
		};
		const profileBefore = profilePaths.map((path) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs }));
		const retiredOnly = await apply();
		assertPreserved();
		assert.deepEqual(retiredOnly, { updated: 0, skipped: 0 });
		for (const [index, path] of profilePaths.entries()) {
			assert.deepEqual(readFileSync(path), profileBefore[index].bytes, path);
			assert.equal(statSync(path).mtimeMs, profileBefore[index].mtime, path);
		}
		assert.deepEqual(__testing.listDiscoverableAgents(project), []);
		for (const dir of roots) {
			assert.deepEqual(__testing.listAgentsFromDir(dir, "user"), []);
			assert.deepEqual(await __testing.listAgentsFromDirAsync(dir, "user"), []);
		}

		// Ordinary delegation/reviewer names and incidental "sdd" text stay routable.
		const ordinary = ["worker", "gentle-ai-worker", "reviewer", "custom-sdd-notes", "sddhelper", "sdd-library.worker"];
		const ordinaryPaths = ordinary.map((identity, index) => {
			const path = join(roots[index % 2 ? 0 : 4], `${identity}.md`);
			put(path, identity === "sdd-library.worker" ? agent("worker", "sdd-library") : agent(identity));
			config[identity] = { model: "new/model", thinking: "high" };
			return path;
		});
		const shadowedWorker = join(roots[0], "worker.md");
		put(shadowedWorker, agent("worker"));
		preserved.set(shadowedWorker, readFileSync(shadowedWorker));
		const providerReviewer = join(roots[4], "review-validator.md");
		put(providerReviewer, agent("review-validator"));
		preserved.set(providerReviewer, readFileSync(providerReviewer));
		config["review-validator"] = { model: "new/model" };
		const discovered = __testing.listDiscoverableAgents(project);
		assert.deepEqual(new Set(discovered.map(({ name }) => name)), new Set([...ordinary, "review-validator"]));
		assert.equal(discovered.find(({ name }) => name === "worker")?.filePath, ordinaryPaths[0]);
		const result = await apply();
		assert.equal(result.updated, ordinary.length * 2);
		assertPreserved();
		for (const path of ordinaryPaths) {
			assert.match(readFileSync(path, "utf8"), /model: new\/model\n/);
			assert.match(readFileSync(path, "utf8"), /thinking: high\n/);
		}
		for (const [index, path] of profilePaths.entries()) {
			const profiles = JSON.parse(readFileSync(path, "utf8"));
			assert.deepEqual(profiles.unrelated, initialProfiles.unrelated);
			for (const [name, value] of Object.entries(oldProfiles)) assert.deepEqual(profiles.model_profiles[name], value, name);
			for (const [agentIndex, name] of ordinary.entries()) {
				if (agentIndex % 2 === index) continue;
				assert.deepEqual(profiles.model_profiles[name], { model: "new/model", effort: "high" });
			}
			assert.equal(profiles.model_profiles["review-validator"], undefined);
		}
		config["sdd-library.worker"] = {};
		await apply();
		assertPreserved();
		assert.doesNotMatch(readFileSync(ordinaryPaths.at(-1)!, "utf8"), /model:|thinking:/);
		assert.equal(JSON.parse(readFileSync(profilePaths[0], "utf8")).model_profiles["sdd-library.worker"], undefined);
	});
}
