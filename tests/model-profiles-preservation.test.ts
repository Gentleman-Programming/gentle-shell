import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyModelConfig, applyModelConfigAsync, applySavedModelConfig } from "../extensions/gentle-ai.ts";

// gentle-ai#4946: the activation sweep re-applies saved routing without user
// consent. Persisted clear entries (an "inherit" saved from /gentle:models is
// `{}`) must not delete `model_profiles` entries the user authored in the
// agent-home `subagents.json`. Clearing stays owned by the consented flows
// that issue it: the panel save and a confirmed profile apply.
function preservedProfilesFixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-model-profiles-"));
	const configHome = join(root, "global");
	const agentHome = join(root, "agent-home");
	for (const dir of [configHome, join(agentHome, "agents")]) {
		mkdirSync(dir, { recursive: true });
	}
	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const isolatedHome = join(root, "home");
	mkdirSync(isolatedHome, { recursive: true });
	process.env.HOME = isolatedHome;
	process.env.USERPROFILE = isolatedHome;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	t.after(() => {
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		rmSync(root, { recursive: true, force: true });
	});

	// A discoverable user-source agent definition, as gentle-pi installs them.
	writeFileSync(
		join(agentHome, "agents", "worker.md"),
		"---\nname: worker\ndescription: Worker\n---\nbody\n",
	);
	const subagentsPath = join(agentHome, "subagents.json");
	const writeUserRouting = () => {
		writeFileSync(
			subagentsPath,
			JSON.stringify({
				max_concurrency: 3,
				model_profiles: {
					worker: { model: "openai/gpt-4o", effort: "high" },
					"my-custom-agent": { model: "anthropic/opus" },
				},
			}),
		);
	};
	writeUserRouting();
	const globalModelsPath = join(configHome, "models.json");
	const context = { cwd: root } as Parameters<typeof applySavedModelConfig>[0];
	return { root, configHome, agentHome, subagentsPath, globalModelsPath, context, writeUserRouting };
}

test("startup sweep keeps user model_profiles entries for persisted clears", async (t) => {
	const fixture = preservedProfilesFixture(t);
	// Saved routing as /gentle:models leaves it after pressing "inherit" on
	// worker: a persisted clear entry. The sweep must not delete the entries.
	writeFileSync(fixture.globalModelsPath, JSON.stringify({ worker: {} }));
	const result = await applySavedModelConfig(fixture.context);
	assert.equal(result.invalidPath, undefined);
	assert.ok(existsSync(fixture.subagentsPath));
	const stored = JSON.parse(readFileSync(fixture.subagentsPath, "utf8"));
	assert.equal(stored.max_concurrency, 3, "unrelated user keys survive");
	assert.equal(
		stored.model_profiles?.worker?.model,
		"openai/gpt-4o",
		"user-authored worker profile must survive a persisted clear entry",
	);
	assert.equal(
		stored.model_profiles?.["my-custom-agent"]?.model,
		"anthropic/opus",
		"user-authored profile for an agent absent from the store must survive",
	);
});

test("activation never deletes empty saved routes, including previously materialized and missing agents", async (t) => {
	for (const scenario of ["user-authored", "previously-materialized", "missing-definition"]) {
		await t.test(scenario, async (t) => {
			const fixture = preservedProfilesFixture(t);
			if (scenario === "previously-materialized") await applyModelConfigAsync(fixture.root, { worker: { model: "openai/alpha", thinking: "high" } });
			const target = scenario === "missing-definition" ? "my-custom-agent" : "worker";
			writeFileSync(fixture.globalModelsPath, `${JSON.stringify({ [target]: {} })}\n`);
			const files = [fixture.subagentsPath, join(fixture.agentHome, "agents", "worker.md"), fixture.globalModelsPath];
			const before = files.map((path) => readFileSync(path, "utf8"));
			for (const phase of ["startup", "reload"]) {
				const result = await applySavedModelConfig(fixture.context);
				assert.equal(result.invalidPath, undefined);
				assert.equal(result.updated, 0, `${phase} must not delete or rewrite routing`);
				assert.deepEqual(files.map((path) => readFileSync(path, "utf8")), before, `${phase} preserves routing, frontmatter, instructions and unrelated keys byte-identically`);
			}
		});
	}
});

test("startup sweep still materializes saved non-clear routing", async (t) => {
	const fixture = preservedProfilesFixture(t);
	writeFileSync(
		fixture.globalModelsPath,
		JSON.stringify({ worker: { model: "openai/alpha", thinking: "high" } }),
	);
	const result = await applySavedModelConfig(fixture.context);
	assert.equal(result.invalidPath, undefined);
	const stored = JSON.parse(readFileSync(fixture.subagentsPath, "utf8"));
	assert.deepEqual(
		stored.model_profiles?.worker,
		{ model: "openai/alpha", effort: "high" },
		"saved routing still materializes",
	);
	assert.equal(
		stored.model_profiles?.["my-custom-agent"]?.model,
		"anthropic/opus",
		"materializing one agent leaves other user entries alone",
	);
	assert.equal(stored.max_concurrency, 3);
});

test("explicit clears and equal-value writes retain sync and async behavior", async (t) => {
	for (const [name, apply] of [["sync", applyModelConfig], ["async", applyModelConfigAsync]] as const) {
		await t.test(name, async (t) => {
			const fixture = preservedProfilesFixture(t);
			const agentPath = join(fixture.agentHome, "agents", "worker.md");
			writeFileSync(agentPath, "---\nname: worker\ndescription: Worker\nmodel: openai/gpt-4o\nthinking: high\n---\nUser instructions.\n");
			const original = readFileSync(fixture.subagentsPath, "utf8");
			const markdown = readFileSync(agentPath, "utf8");
			const unchanged = await apply(fixture.root, { worker: { model: "openai/gpt-4o", thinking: "high" } });
			assert.equal(unchanged.updated, 0);
			assert.equal(readFileSync(fixture.subagentsPath, "utf8"), original);
			assert.equal(readFileSync(agentPath, "utf8"), markdown);
			const cleared = await apply(fixture.root, { worker: {} });
			assert.equal(cleared.updated, 2, "explicit clear updates both routing surfaces");
			assert.deepEqual(JSON.parse(readFileSync(fixture.subagentsPath, "utf8")), {
				max_concurrency: 3, model_profiles: { "my-custom-agent": { model: "anthropic/opus" } },
			});
			const stored = readFileSync(agentPath, "utf8");
			assert.doesNotMatch(stored, /^model:/m);
			assert.doesNotMatch(stored, /^thinking:/m);
			assert.ok(stored.endsWith("User instructions.\n"));
		});
	}
});
