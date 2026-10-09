import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

test("equal-value routing does not claim user profiles in either apply path", async (t) => {
	for (const [name, apply] of [["sync", applyModelConfig], ["async", applyModelConfigAsync]] as const) {
		await t.test(name, async (t) => {
			const fixture = preservedProfilesFixture(t);
			const original = readFileSync(fixture.subagentsPath, "utf8");
			await apply(fixture.root, { worker: { model: "openai/gpt-4o", thinking: "high" } });
			assert.equal(readFileSync(fixture.subagentsPath, "utf8"), original, "equal routing is not rewritten");
			writeFileSync(fixture.globalModelsPath, JSON.stringify({ worker: {} }));
			const result = await applySavedModelConfig(fixture.context);
			assert.equal(result.updated, 0, "the sweep must skip the never-materialized clear");
			assert.equal(readFileSync(fixture.subagentsPath, "utf8"), original, "user routing survives the later clear");
		});
	}
});

test("overlapping sync and async ownership updates preserve additions and removals", async (t) => {
	for (const operation of ["add", "remove"] as const) {
		await t.test(operation, async (t) => {
			const fixture = preservedProfilesFixture(t);
			writeFileSync(join(fixture.agentHome, "agents", "helper.md"), "---\nname: helper\ndescription: Helper\n---\nbody\n");
			if (operation === "remove") {
				applyModelConfig(fixture.root, { helper: { model: "openai/helper" } });
			}
			const originalWrite = fsPromises.writeFile;
			let interleaved = false;
			const mock = t.mock.method(fsPromises, "writeFile", async (...args: Parameters<typeof originalWrite>) => {
				if (String(args[0]) === fixture.subagentsPath && !interleaved) {
					interleaved = true;
					// The async path has read its inputs but has not committed routing.
					// Another session's synchronous mutation commits in this interval.
					applyModelConfig(fixture.root, { helper: operation === "add" ? { model: "openai/helper" } : {} });
				}
				return originalWrite(...args);
			});
			syncBuiltinESMExports();
			try {
				await applyModelConfigAsync(fixture.root, { worker: { model: "openai/worker" } });
			} finally {
				mock.mock.restore();
				syncBuiltinESMExports();
			}
			assert.equal(interleaved, true, "the sync mutation must occur before the async routing write");
			// Restore both visible entries to probe ownership through a public sweep,
			// independently of the existing whole-subagents.json write race.
			writeFileSync(fixture.subagentsPath, JSON.stringify({
				max_concurrency: 3,
				model_profiles: {
					worker: { model: "openai/worker" },
					helper: { model: "openai/helper" },
					"my-custom-agent": { model: "anthropic/opus" },
				},
			}));
			writeFileSync(fixture.globalModelsPath, JSON.stringify({ worker: {}, helper: {} }));
			const result = await applySavedModelConfig(fixture.context);
			assert.equal(result.invalidPath, undefined);
			const stored = JSON.parse(readFileSync(fixture.subagentsPath, "utf8"));
			assert.equal("worker" in stored.model_profiles, false, "the async materialized entry is cleared");
			assert.equal("helper" in stored.model_profiles, operation === "remove", "the sync ownership mutation survives");
			assert.equal(stored.max_concurrency, 3);
			assert.deepEqual(stored.model_profiles["my-custom-agent"], { model: "anthropic/opus" });
		});
	}
});

test("both apply paths coordinate ownership with another process", async (t) => {
	for (const [name, apply] of [["sync", applyModelConfig], ["async", applyModelConfigAsync]] as const) {
		await t.test(name, async (t) => {
			const fixture = preservedProfilesFixture(t);
			const trackingDir = join(fixture.agentHome, "gentle-ai");
			mkdirSync(trackingDir, { recursive: true });
			const lockPath = join(trackingDir, "materialized-model-profiles.json.lock");
			const owner = spawn(process.execPath, ["-e", `
				const fs = require('node:fs');
				const path = process.argv[1];
				const native = require('fs-native-extensions');
				const fd = fs.openSync(path, 'a+', 0o600);
				if (!native.tryLock(fd)) throw new Error('lock unavailable');
				process.on('message', () => {
					native.unlock(fd);
					fs.closeSync(fd);
					process.exit(0);
				});
				process.send('locked');
			`, lockPath], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
			const exited = once(owner, "exit");
			t.after(() => owner.kill());
			assert.deepEqual(await once(owner, "message"), ["locked", undefined]);
			const originalOpen = fs.openSync;
			let waited = false;
			const mock = t.mock.method(fs, "openSync", (...args: Parameters<typeof originalOpen>) => {
				const fd = originalOpen(...args);
				if (String(args[0]) === lockPath && !waited) {
					waited = true;
					owner.send("release");
				}
				return fd;
			});
			syncBuiltinESMExports();
			try {
				await apply(fixture.root, { worker: { model: "openai/materialized" } });
				assert.equal(waited, true, "ownership must wait for the other process's lock");
				assert.deepEqual(await exited, [0, null]);
			} finally {
				mock.mock.restore();
				syncBuiltinESMExports();
				owner.kill();
			}
			writeFileSync(fixture.globalModelsPath, JSON.stringify({ worker: {} }));
			const result = await applySavedModelConfig(fixture.context);
			assert.equal(result.updated, 2, "routing and frontmatter clear after ownership is committed");
			const stored = JSON.parse(readFileSync(fixture.subagentsPath, "utf8"));
			assert.equal("worker" in stored.model_profiles, false);
			assert.deepEqual(stored.model_profiles["my-custom-agent"], { model: "anthropic/opus" });
			assert.equal(stored.max_concurrency, 3);
		});
	}
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

test("legacy lock contents and age do not block kernel ownership", async (t) => {
	const deadChild = spawn(process.execPath, ["-e", "process.exit(0)"]);
	const [code] = await once(deadChild, "exit");
	assert.equal(code, 0);
	const deadPid = deadChild.pid!;
	for (const [name, stranded] of [
		["dead owner", `${JSON.stringify({ pid: deadPid, createdAtMs: Date.now() })}\n`],
		["unreadable stale owner", ""],
	] as const) {
		await t.test(name, async (t) => {
			const fixture = preservedProfilesFixture(t);
			const trackingDir = join(fixture.agentHome, "gentle-ai");
			mkdirSync(trackingDir, { recursive: true });
			const lockPath = join(trackingDir, "materialized-model-profiles.json.lock");
			writeFileSync(lockPath, stranded);
			if (stranded === "") {
				// Age the unreadable lock past the maximum plausible critical section.
				const stale = new Date(Date.now() - 120_000);
				utimesSync(lockPath, stale, stale);
			}
			await applyModelConfigAsync(fixture.root, { worker: { model: "openai/materialized" } });
			const sidecar = JSON.parse(readFileSync(join(trackingDir, "materialized-model-profiles.json"), "utf8"));
			assert.deepEqual(sidecar.agents, ["worker"], "bookkeeping recovered through the healed lock");
			assert.equal(existsSync(lockPath), true, "the permanent mutex path survives");
			assert.equal(readFileSync(lockPath, "utf8"), stranded, "legacy contents do not confer ownership and are not replaced");
			writeFileSync(fixture.globalModelsPath, JSON.stringify({ worker: {} }));
			const result = await applySavedModelConfig(fixture.context);
			assert.equal(result.updated, 2, "the recovered ownership lets a sweep clear the materialized route");
			const stored = JSON.parse(readFileSync(fixture.subagentsPath, "utf8"));
			assert.equal("worker" in stored.model_profiles, false);
			assert.equal(stored.model_profiles["my-custom-agent"].model, "anthropic/opus");
		});
	}
});
