import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyModelConfig, applySavedModelConfig } from "../extensions/gentle-ai.ts";

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

test("startup sweep keeps user model_profiles entries a persisted clear never owned", async (t) => {
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

test("consented panel save still clears the routing it was told to inherit", async (t) => {
	const fixture = preservedProfilesFixture(t);
	// /gentle:models routes a save through applyModelConfig with the user's
	// draft: an explicit inherit is a clear entry and must keep clearing.
	await applyModelConfig(fixture.root, { worker: {} });
	const stored = JSON.parse(readFileSync(fixture.subagentsPath, "utf8"));
	assert.equal("worker" in (stored.model_profiles ?? {}), false, "consented clear still clears");
	assert.equal(
		stored.model_profiles?.["my-custom-agent"]?.model,
		"anthropic/opus",
		"a clear for one agent still leaves other user entries alone",
	);
	assert.equal(stored.max_concurrency, 3);
});
