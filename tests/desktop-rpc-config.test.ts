import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { parseAgentsConfig, loadAgentsConfig } from "../lib/agents-config.ts";
import { FALLBACKS_KIND, FALLBACKS_VERSION, fallbacksFilePath, normalizeFallbacksFile } from "../lib/model-fallback-store.ts";
import { PROFILES_KIND, PROFILES_VERSION, normalizeProfilesFile, profilesFilePath, serializeProfilesFile } from "../lib/agent-profiles.ts";
import { PROFILE_PIN_KIND, PROFILE_PIN_VERSION, localProfilePinPath, repoProfileDeclarationPath, serializeProfilePin } from "../lib/agent-profile-pin.ts";
import { DESKTOP_CONFIG_EVENTS, DESKTOP_CONFIG_METHODS, DESKTOP_CONFIG_STORES, DesktopConfigBridge } from "../lib/desktop-rpc-config.ts";
import { DESKTOP_RPC_SCHEMA, DESKTOP_RPC_WIDGET } from "../lib/desktop-rpc.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";
import type { WorktreeIdentity } from "../lib/session-worktree-registry.ts";

// The Desktop read-side config slice: `get_config` over the existing owner
// readers. Every test runs in an isolated temporary root, so no real user
// config, auth file, or repository store is ever read.

interface Env {
	root: string;
	configHome: string;
	agentHome: string;
	workspace: string;
}

function isolatedEnvironment(t: test.TestContext): Env {
	const root = mkdtempSync(join(tmpdir(), "gentle-desktop-config-"));
	const configHome = join(root, "config");
	const agentHome = join(root, "agent");
	const workspace = join(root, "workspace");
	for (const directory of [configHome, agentHome, workspace]) mkdirSync(directory, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, configHome, agentHome, workspace };
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function profilesFixture(): Record<string, unknown> {
	return {
		kind: PROFILES_KIND,
		version: PROFILES_VERSION,
		active: "team",
		profiles: {
			team: {
				explore: { model: "anthropic/claude-explore" },
				orchestrator: { model: "openai/gpt-orchestrator" },
			},
			ops: { worker: { model: "openai/gpt-worker", thinking: "high" } },
		},
	};
}

function pin(profile: string): Record<string, unknown> {
	return { kind: PROFILE_PIN_KIND, version: PROFILE_PIN_VERSION, profile };
}

function bridgeFor(env: Env, resolveWorktree?: () => WorktreeIdentity | undefined): DesktopConfigBridge {
	const bridge = new DesktopConfigBridge({
		configHome: env.configHome,
		agentHome: env.agentHome,
		...(resolveWorktree === undefined ? {} : { resolveWorktree }),
	});
	bridge.attach({ cwd: env.workspace } as unknown as ExtensionContext);
	return bridge;
}

async function readStore(bridge: DesktopConfigBridge, store: string, params: Record<string, unknown> = {}): Promise<any> {
	const outcome = await bridge.handle("get_config", { store, ...params });
	assert.ok(outcome, "get_config must answer");
	assert.equal(outcome.ok, true, `unexpected failure: ${JSON.stringify(outcome)}`);
	return outcome.data;
}

function expectedRevision(payload: unknown): string {
	const canonical = (value: unknown): string => {
		if (value === undefined) return "null";
		if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
		if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`);
		return `{${entries.join(",")}}`;
	};
	return `sha256:${createHash("sha256").update(canonical(payload)).digest("hex").slice(0, 32)}`;
}

test("profiles reads the normalized global store with stable revisions and mutable metadata", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const bridge = bridgeFor(env);

	const first = await readStore(bridge, "profiles");
	const second = await readStore(bridge, "profiles");

	assert.equal(first.store, "profiles");
	assert.equal(first.scope, "global");
	assert.equal(first.readOnly, false, "profiles is an authoritative, later-mutable store");
	assert.equal(first.status, "ok");
	assert.deepEqual(first.layers, [{ source: "global", status: "ok" }]);
	assert.deepEqual(first.value, {
		kind: PROFILES_KIND,
		version: PROFILES_VERSION,
		active: "team",
		profiles: {
			team: {
				explore: { model: "anthropic/claude-explore" },
				orchestrator: { model: "openai/gpt-orchestrator" },
			},
			ops: { worker: { model: "openai/gpt-worker", thinking: "high" } },
		},
	});
	assert.match(first.revision, /^sha256:[a-f0-9]{32}$/);
	assert.equal(second.revision, first.revision, "equivalent reads keep one revision");
	assert.equal(
		first.revision,
		expectedRevision({ store: "profiles", status: "ok", value: first.value }),
		"the revision is derived from the canonical current content",
	);
	assert.deepEqual(second.value, first.value);
});

test("profiles reports missing and malformed files without repairing them", async (t) => {
	const env = isolatedEnvironment(t);
	const bridge = bridgeFor(env);
	const path = profilesFilePath(env.configHome);

	const missing = await readStore(bridge, "profiles");
	assert.equal(missing.status, "missing");
	assert.equal(missing.value, undefined, "a missing store carries no invented value");
	assert.equal(missing.readOnly, false);
	assert.deepEqual(missing.layers, [{ source: "global", status: "missing" }]);
	assert.equal(missing.revision, expectedRevision({ store: "profiles", status: "missing" }));

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "{ not json\n");
	const before = { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
	const malformed = await readStore(bridge, "profiles");
	const after = { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };

	assert.equal(malformed.status, "invalid");
	assert.equal(malformed.value, undefined);
	assert.deepEqual(malformed.layers, [{ source: "global", status: "invalid" }]);
	assert.equal(malformed.revision, expectedRevision({ store: "profiles", status: "invalid" }));
	assert.deepEqual(after, before, "a read never repairs or rewrites a malformed file");
	assert.notEqual(malformed.revision, missing.revision, "missing and invalid are different content");
});

test("models merges the global store over the legacy project store read-only", async (t) => {
	const env = isolatedEnvironment(t);
	const globalConfig = {
		explore: { model: "anthropic/claude-global" },
		worker: { model: "openai/gpt-global" },
		"__proto__": { model: "openai/gpt-hostile" },
	};
	const projectConfig = {
		explore: { model: "anthropic/claude-project" },
		review: { model: "openai/gpt-project", thinking: "low" },
	};
	writeJson(join(env.configHome, "models.json"), globalConfig);
	writeJson(join(env.workspace, ".pi", "gentle-ai", "models.json"), projectConfig);

	const data = await readStore(bridgeFor(env), "models");

	assert.equal(data.scope, "global+project");
	assert.equal(data.readOnly, true, "models is materialized routing, never a Desktop write target");
	assert.equal(data.status, "ok");
	assert.deepEqual(data.layers, [
		{ source: "global", status: "ok" },
		{ source: "project", status: "ok" },
	]);
	// Global wins per agent, project-only agents merge in, and unsafe keys are dropped.
	assert.deepEqual(data.value, {
		explore: { model: "anthropic/claude-global" },
		worker: { model: "openai/gpt-global" },
		review: { model: "openai/gpt-project", thinking: "low" },
	});
	assert.equal(Object.prototype.hasOwnProperty.call(data.value, "__proto__"), false);
});

test("models reports missing layers and a malformed layer truthfully", async (t) => {
	const env = isolatedEnvironment(t);
	const bridge = bridgeFor(env);

	const missing = await readStore(bridge, "models");
	assert.equal(missing.status, "missing");
	assert.equal(missing.value, undefined);
	assert.deepEqual(missing.layers, [
		{ source: "global", status: "missing" },
		{ source: "project", status: "missing" },
	]);

	writeJson(join(env.workspace, ".pi", "gentle-ai", "models.json"), { worker: { model: "openai/gpt-project" } });
	const projectOnly = await readStore(bridge, "models");
	assert.equal(projectOnly.status, "ok");
	assert.deepEqual(projectOnly.value, { worker: { model: "openai/gpt-project" } });
	assert.deepEqual(projectOnly.layers, [
		{ source: "global", status: "missing" },
		{ source: "project", status: "ok" },
	]);

	mkdirSync(env.configHome, { recursive: true });
	writeFileSync(join(env.configHome, "models.json"), "[1,2,3]\n");
	const invalid = await readStore(bridge, "models");
	assert.equal(invalid.status, "invalid");
	assert.equal(invalid.value, undefined, "a broken global layer never yields a partial value");
	assert.deepEqual(invalid.layers, [
		{ source: "global", status: "invalid" },
		{ source: "project", status: "ok" },
	]);
});

test("profile_fallbacks reads normalized chains and reports malformed content", async (t) => {
	const env = isolatedEnvironment(t);
	const path = fallbacksFilePath(env.configHome);
	writeJson(path, {
		kind: FALLBACKS_KIND,
		version: FALLBACKS_VERSION,
		profiles: {
			team: {
				"*": [{ model: "openai/gpt-shared" }],
				worker: [{ model: "openai/gpt-worker", thinking: "low" }],
			},
		},
	});
	const bridge = bridgeFor(env);

	const data = await readStore(bridge, "profile_fallbacks");
	assert.equal(data.scope, "global");
	assert.equal(data.readOnly, false, "fallback chains are authoritative and later mutable");
	assert.equal(data.status, "ok");
	assert.deepEqual(data.layers, [{ source: "global", status: "ok" }]);
	assert.deepEqual(data.value, {
		kind: FALLBACKS_KIND,
		version: FALLBACKS_VERSION,
		profiles: {
			team: {
				"*": [{ model: "openai/gpt-shared" }],
				worker: [{ model: "openai/gpt-worker", thinking: "low" }],
			},
		},
	});

	writeFileSync(path, `${JSON.stringify({ kind: FALLBACKS_KIND, version: FALLBACKS_VERSION, profiles: { team: { worker: "nope" } } })}\n`);
	const invalid = await readStore(bridge, "profile_fallbacks");
	assert.equal(invalid.status, "invalid");
	assert.equal(invalid.value, undefined);
});

test("subagents merges global and project stores through the owner parser read-only", async (t) => {
	const env = isolatedEnvironment(t);
	const globalConfig = {
		default_model: "anthropic/claude-default",
		model_profiles: {
			explore: { model: "anthropic/claude-sub-global", effort: "medium" },
			worker: { model: "openai/gpt-sub-global" },
		},
		max_concurrency: 7,
	};
	const projectConfig = {
		model_profiles: {
			explore: { model: "anthropic/claude-sub-project" },
			review: { model: "openai/gpt-sub-project" },
		},
		max_concurrency: 3,
	};
	writeJson(join(env.agentHome, "subagents.json"), globalConfig);
	writeJson(join(env.workspace, ".pi", "subagents.json"), projectConfig);

	const data = await readStore(bridgeFor(env), "subagents");

	assert.equal(data.scope, "global+project");
	assert.equal(data.readOnly, true, "subagents.json is owner-materialized routing");
	assert.equal(data.status, "ok");
	assert.deepEqual(data.layers, [
		{ source: "global", status: "ok" },
		{ source: "project", status: "ok" },
	]);
	// The owner parser is the oracle; the projection matches its wire form.
	assert.deepEqual(data.value, JSON.parse(JSON.stringify(parseAgentsConfig(globalConfig, projectConfig))));
	assert.equal(data.value.maxConcurrency, 3);
	assert.equal(data.value.modelProfiles.explore.model.id, "claude-sub-project");
	assert.equal(data.value.modelProfiles.explore.thinking, "medium");
});

test("subagents merges the valid layer when the other layer is malformed", async (t) => {
	const env = isolatedEnvironment(t);
	const globalConfig = {
		model_profiles: { explore: { model: "anthropic/claude-sub-global" } },
		max_concurrency: 7,
	};
	writeJson(join(env.agentHome, "subagents.json"), globalConfig);
	mkdirSync(join(env.workspace, ".pi"), { recursive: true });
	const projectPath = join(env.workspace, ".pi", "subagents.json");
	writeFileSync(projectPath, "[not, an, object]\n");

	const data = await readStore(bridgeFor(env), "subagents");

	// The runtime's own reader skips a layer it cannot parse and merges the rest,
	// so the projection must answer the same way while still naming the bad layer.
	assert.equal(data.status, "ok", "one malformed layer must not invalidate the whole store");
	assert.deepEqual(data.layers, [
		{ source: "global", status: "ok" },
		{ source: "project", status: "invalid" },
	]);
	assert.deepEqual(
		data.value,
		JSON.parse(JSON.stringify(loadAgentsConfig({ cwd: env.workspace, home: env.agentHome, agentHome: env.agentHome }))),
		"the projection matches the owner config a launch would read",
	);
	assert.equal(data.value.maxConcurrency, 7);

	// Every layer unusable is reported as such: the owner would fall back to its
	// defaults, which is not the content of this store.
	writeFileSync(join(env.agentHome, "subagents.json"), "{ broken\n");
	const allInvalid = await readStore(bridgeFor(env), "subagents");
	assert.equal(allInvalid.status, "invalid");
	assert.equal(allInvalid.value, undefined);
	assert.deepEqual(allInvalid.layers, [
		{ source: "global", status: "invalid" },
		{ source: "project", status: "invalid" },
	]);
	assert.notEqual(allInvalid.revision, data.revision);

	// A missing layer is not a malformed one: the other layer still merges.
	writeJson(join(env.agentHome, "subagents.json"), globalConfig);
	rmSync(projectPath);
	const missingProject = await readStore(bridgeFor(env), "subagents");
	assert.equal(missingProject.status, "ok");
	assert.deepEqual(missingProject.layers, [
		{ source: "global", status: "ok" },
		{ source: "project", status: "missing" },
	]);
	assert.equal(missingProject.value.maxConcurrency, 7);
});

test("pins resolve local over repo without exposing layer paths", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const identity: WorktreeIdentity = { root: env.workspace, commonDir: join(env.root, "git-common") };
	writeJson(localProfilePinPath(identity.commonDir), pin("team"));
	writeJson(repoProfileDeclarationPath(identity.root), pin("ops"));

	const data = await readStore(bridgeFor(env, () => identity), "pins");

	assert.equal(data.scope, "local+repo");
	assert.equal(data.readOnly, false, "a repository pin stays an authoritative store");
	assert.equal(data.status, "ok");
	assert.deepEqual(data.layers, [
		{ source: "local", status: "ok" },
		{ source: "repo", status: "ok" },
	]);
	assert.deepEqual(data.value, {
		resolved: true,
		winner: { source: "local", profile: "team" },
		invalid: [],
		stale: [],
	});
	assert.equal(JSON.stringify(data).includes(env.root), false, "no physical path crosses the contract");
});

test("pins report stale and invalid layers instead of hiding them", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const identity: WorktreeIdentity = { root: env.workspace, commonDir: join(env.root, "git-common") };
	const bridge = bridgeFor(env, () => identity);

	writeJson(localProfilePinPath(identity.commonDir), pin("gone"));
	writeJson(repoProfileDeclarationPath(identity.root), pin("ops"));
	const stale = await readStore(bridge, "pins");
	assert.equal(stale.status, "ok", "a lower layer still resolves");
	assert.deepEqual(stale.value, {
		resolved: true,
		winner: { source: "repo", profile: "ops" },
		invalid: [],
		stale: [{ source: "local", profile: "gone" }],
	});
	assert.deepEqual(stale.layers, [
		{ source: "local", status: "ok" },
		{ source: "repo", status: "ok" },
	]);

	mkdirSync(dirname(localProfilePinPath(identity.commonDir)), { recursive: true });
	writeFileSync(localProfilePinPath(identity.commonDir), "{ broken\n");
	const invalidLayer = await readStore(bridge, "pins");
	assert.equal(invalidLayer.status, "ok");
	assert.deepEqual(invalidLayer.layers, [
		{ source: "local", status: "invalid" },
		{ source: "repo", status: "ok" },
	]);
	assert.deepEqual(invalidLayer.value.invalid, [{ source: "local" }]);
	assert.deepEqual(invalidLayer.value.winner, { source: "repo", profile: "ops" });
});

test("pins report missing, unresolvable, and non-worktree cases truthfully", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const identity: WorktreeIdentity = { root: env.workspace, commonDir: join(env.root, "git-common") };

	const noPin = await readStore(bridgeFor(env, () => identity), "pins");
	assert.equal(noPin.status, "missing");
	assert.deepEqual(noPin.value, { resolved: false, invalid: [], stale: [] });

	const outside = await readStore(bridgeFor(env, () => undefined), "pins");
	assert.equal(outside.status, "invalid");
	assert.equal(outside.layers.length, 0);
	assert.deepEqual(outside.value, { resolved: false, invalid: [], stale: [], reason: "worktree_unresolved" });

	writeJson(localProfilePinPath(identity.commonDir), pin("gone"));
	const unresolvable = await readStore(bridgeFor(env, () => identity), "pins");
	assert.equal(unresolvable.status, "invalid", "no layer resolves to a stored profile");
	assert.deepEqual(unresolvable.value, {
		resolved: false,
		invalid: [],
		stale: [{ source: "local", profile: "gone" }],
	});
});

test("managed_assets reads the agent-home manifest read-only", async (t) => {
	const env = isolatedEnvironment(t);
	const path = join(env.agentHome, "gentle-ai", "managed-assets.json");
	writeJson(path, { schemaVersion: 1, assets: { "agents/gentle-ai-worker.md": "a".repeat(64) } });

	const data = await readStore(bridgeFor(env), "managed_assets");
	assert.equal(data.scope, "global");
	assert.equal(data.readOnly, true, "the managed-asset manifest belongs to the installer");
	assert.equal(data.status, "ok");
	assert.deepEqual(data.layers, [{ source: "global", status: "ok" }]);
	assert.deepEqual(data.value, { schemaVersion: 1, assets: { "agents/gentle-ai-worker.md": "a".repeat(64) } });

	writeJson(path, { schemaVersion: 99, assets: {} });
	const unsupported = await readStore(bridgeFor(env), "managed_assets");
	assert.equal(unsupported.status, "invalid");
	assert.equal(unsupported.value, undefined);

	rmSync(path);
	const missing = await readStore(bridgeFor(env), "managed_assets");
	assert.equal(missing.status, "missing");
});

test("managed_assets projects only ownership-shaped keys and hashes", async (t) => {
	const env = isolatedEnvironment(t);
	const path = join(env.agentHome, "gentle-ai", "managed-assets.json");
	const hash = "b".repeat(64);
	writeJson(path, {
		schemaVersion: 1,
		assets: {
			"agents/gentle-ai-worker.md": hash,
			"/etc/passwd": hash,
			"agents/../../escape.md": hash,
			"agents/back\\slash.md": hash,
			"C:/windows/system32/evil.md": hash,
			"agents//empty-segment.md": hash,
			"/leading.md": hash,
			"agents/empty-hash.md": "",
			"agents/not-a-hash.md": "not-a-sha256-digest",
			"agents/short-hash.md": hash.slice(0, 63),
		},
	});

	const data = await readStore(bridgeFor(env), "managed_assets");

	assert.equal(data.status, "ok");
	assert.deepEqual(data.value, { schemaVersion: 1, assets: { "agents/gentle-ai-worker.md": hash } });
	const wire = JSON.stringify(data);
	for (const leaked of ["passwd", "escape", "windows", "not-a-sha256-digest"]) {
		assert.equal(wire.includes(leaked), false, `a non-ownership entry never crosses the contract: ${leaked}`);
	}
	assert.equal(wire.includes(env.root), false);
});

test("managed_assets preserves a shipped legacy manifest without filtering valid entries", async (t) => {
	const env = isolatedEnvironment(t);
	const legacy = JSON.parse(readFileSync(new URL("../assets/migrations/managed-assets-v2.5.0.json", import.meta.url), "utf8"));
	const path = join(env.agentHome, "gentle-ai", "managed-assets.json");
	writeJson(path, legacy);

	const data = await readStore(bridgeFor(env), "managed_assets");

	assert.equal(data.status, "ok");
	assert.deepEqual(data.value, { schemaVersion: legacy.schemaVersion, assets: legacy.assets });
	assert.deepEqual(Object.keys(data.value.assets), Object.keys(legacy.assets), "every shipped ownership entry survives");
});

test("revisions stay stable for equivalent content and change when content changes", async (t) => {
	const env = isolatedEnvironment(t);
	const path = profilesFilePath(env.configHome);
	const bridge = bridgeFor(env);
	const fixture = profilesFixture();

	writeJson(path, fixture);
	const first = await readStore(bridge, "profiles");

	// Same normalized content, different byte layout: the revision must not move.
	writeFileSync(
		path,
		`{"profiles":${JSON.stringify(fixture.profiles)},"active":"team","version":1,"kind":"${PROFILES_KIND}"}`,
	);
	const reordered = await readStore(bridge, "profiles");
	assert.notEqual(readFileSync(path, "utf8"), JSON.stringify(fixture), "the bytes really differ");
	assert.equal(reordered.revision, first.revision, "revision tracks normalized content, not formatting");

	writeJson(path, { ...fixture, active: "ops" });
	const changed = await readStore(bridge, "profiles");
	assert.notEqual(changed.revision, first.revision, "a content change moves the revision");
	assert.equal(changed.value.active, "ops");
});

test("get_config rejects unknown stores, unsupported params, and physical paths", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const bridge = bridgeFor(env);

	const unknownStore = await bridge.handle("get_config", { store: "auth" });
	assert.deepEqual(unknownStore, {
		ok: false,
		error: { code: "unknown_store", message: "Unknown Desktop config store" },
	});

	for (const params of [
		{},
		{ store: 42 },
		{ store: "profiles", path: join(env.root, "config", "profiles.json") },
		{ store: "profiles", scope: "project" },
		{ store: "profiles", physical_path: "/etc/passwd" },
	]) {
		const outcome = await bridge.handle("get_config", params as Record<string, unknown>);
		assert.equal(outcome?.ok, false, `expected rejection for ${JSON.stringify(params)}`);
		assert.equal((outcome as { error: { code: string } }).error.code, "invalid_request");
		assert.equal(JSON.stringify(outcome).includes(env.root), false, "no physical path is echoed back");
	}

	assert.deepEqual(DESKTOP_CONFIG_METHODS, ["get_config", "set_config"]);
	assert.deepEqual([...DESKTOP_CONFIG_EVENTS], ["config_changed"]);
	assert.deepEqual([...DESKTOP_CONFIG_STORES], ["profiles", "models", "profile_fallbacks", "subagents", "pins", "managed_assets"]);
});

test("reads never mutate any store", async (t) => {
	const env = isolatedEnvironment(t);
	const identity: WorktreeIdentity = { root: env.workspace, commonDir: join(env.root, "git-common") };
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	writeJson(join(env.configHome, "models.json"), { explore: { model: "anthropic/claude-global" } });
	writeJson(fallbacksFilePath(env.configHome), { kind: FALLBACKS_KIND, version: FALLBACKS_VERSION, profiles: {} });
	writeJson(join(env.agentHome, "subagents.json"), { model_profiles: { explore: { model: "anthropic/claude-sub" } } });
	writeJson(join(env.workspace, ".pi", "gentle-ai", "models.json"), { worker: { model: "openai/gpt-project" } });
	writeJson(join(env.workspace, ".pi", "subagents.json"), { max_concurrency: 2 });
	writeJson(localProfilePinPath(identity.commonDir), pin("team"));
	writeJson(repoProfileDeclarationPath(identity.root), pin("ops"));
	writeJson(join(env.agentHome, "gentle-ai", "managed-assets.json"), { schemaVersion: 1, assets: {} });
	const bridge = bridgeFor(env, () => identity);

	const before = snapshotTree(env.root);
	for (const store of DESKTOP_CONFIG_STORES) await readStore(bridge, store);
	bridge.snapshotState();
	assert.deepEqual(snapshotTree(env.root), before, "a read is not a write: bytes, mtimes, and file set are unchanged");
});

test("the snapshot projects bounded per-store metadata and no store content", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const bridge = bridgeFor(env);

	const state = bridge.snapshotState() as { config: { stores: Array<Record<string, unknown>> } };

	assert.deepEqual(
		state.config.stores.map((entry) => entry.store),
		[...DESKTOP_CONFIG_STORES],
	);
	for (const entry of state.config.stores) {
		assert.deepEqual(Object.keys(entry).sort(), ["readOnly", "revision", "scope", "status", "store"]);
		assert.match(String(entry.revision), /^sha256:[a-f0-9]{32}$/);
	}
	assert.equal(state.config.stores[0]!.status, "ok");
	assert.equal(state.config.stores[1]!.status, "missing");
	assert.equal(JSON.stringify(state).includes("claude-explore"), false, "raw store content never enters a snapshot");
	assert.equal(JSON.stringify(state).includes(env.root), false);
	assert.ok(JSON.stringify(state).length < 2048, "the projection stays bounded");
});

test("stores carry the documented read-only split", async (t) => {
	const env = isolatedEnvironment(t);
	const bridge = bridgeFor(env);
	const readOnly: Record<string, boolean> = {};
	for (const store of DESKTOP_CONFIG_STORES) readOnly[store] = (await readStore(bridge, store)).readOnly;
	assert.deepEqual(readOnly, {
		profiles: false,
		models: true,
		profile_fallbacks: false,
		subagents: true,
		pins: false,
		managed_assets: true,
	});
});

test("a host without a session cwd answers unavailable instead of guessing paths", async (t) => {
	const env = isolatedEnvironment(t);
	const bridge = new DesktopConfigBridge({ configHome: env.configHome, agentHome: env.agentHome });
	bridge.attach({ mode: "rpc" } as unknown as ExtensionContext);

	const outcome = await bridge.handle("get_config", { store: "profiles" });
	assert.deepEqual(outcome, {
		ok: false,
		error: { code: "config_unavailable", message: "Config stores unavailable for this session" },
	});
	assert.deepEqual(bridge.snapshotState(), {}, "no session cwd means no truthful projection");

	bridge.reset();
	assert.deepEqual(await bridge.handle("get_config", { store: "profiles" }), {
		ok: false,
		error: { code: "config_unavailable", message: "Config stores unavailable for this session" },
	});
});

// ---- Write contract: `set_config` over the authoritative owners ----

async function writeTargetRevision(bridge: DesktopConfigBridge, store: string, target = "global"): Promise<string> {
	const data = await readStore(bridge, store);
	const targets = data.writeTargets as Array<{ target: string; status: string; writeRevision: string }> | undefined;
	assert.ok(targets, `${store} must expose its write targets`);
	const entry = targets.find((candidate) => candidate.target === target);
	assert.ok(entry, `${store} must expose the ${target} write target`);
	assert.match(entry.writeRevision, /^sha256:[a-f0-9]{32}$/);
	return entry.writeRevision;
}

async function setConfig(bridge: DesktopConfigBridge, params: Record<string, unknown>): Promise<any> {
	const outcome = await bridge.handle("set_config", params);
	assert.ok(outcome, "set_config must answer");
	return outcome;
}

function assertError(outcome: any, code: string): void {
	assert.equal(outcome.ok, false, `expected ${code}: ${JSON.stringify(outcome)}`);
	assert.equal(outcome.error.code, code);
	assert.equal(outcome.event, undefined, "a rejected write emits nothing");
}

function withProfile(name: string, model: string): Record<string, unknown> {
	const fixture = profilesFixture();
	return {
		...fixture,
		profiles: { ...(fixture.profiles as Record<string, unknown>), [name]: { worker: { model } } },
	};
}

test("profiles accepts a validated write and reports the resulting store", async (t) => {
	const env = isolatedEnvironment(t);
	const path = profilesFilePath(env.configHome);
	writeJson(path, profilesFixture());
	const bridge = bridgeFor(env);
	const before = await readStore(bridge, "profiles");
	const beforeWrite = await writeTargetRevision(bridge, "profiles");
	const data = withProfile("extra", "openai/gpt-extra");

	const outcome = await setConfig(bridge, { store: "profiles", data, expectedRevision: beforeWrite });

	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.equal(outcome.data.store, "profiles");
	assert.equal(outcome.data.scope, "global");
	assert.equal(outcome.data.readOnly, false);
	assert.equal(outcome.data.status, "ok");
	assert.equal(outcome.data.writeTarget, "global");
	assert.equal(outcome.data.changed, true);
	assert.deepEqual(Object.keys(outcome.data.value.profiles).sort(), ["extra", "ops", "team"]);
	assert.notEqual(outcome.data.revision, before.revision, "the read revision moved");
	assert.notEqual(outcome.data.writeRevision, beforeWrite, "the write revision moved");
	assert.equal(
		readFileSync(path, "utf8"),
		serializeProfilesFile(normalizeProfilesFile(data)!.file),
		"the store holds exactly the owner-serialized normalized data",
	);
	assert.equal(outcome.event?.name, "config_changed");
	assert.deepEqual(outcome.event?.data, {
		store: "profiles",
		scope: "global",
		writeTarget: "global",
		revision: outcome.data.revision,
		writeRevision: outcome.data.writeRevision,
		source: "desktop",
	});
	assert.equal(JSON.stringify(outcome).includes(env.root), false, "no physical path crosses the contract");
});

test("profiles creates a missing store from its missing-state write revision", async (t) => {
	const env = isolatedEnvironment(t);
	const path = profilesFilePath(env.configHome);
	const bridge = bridgeFor(env);
	const missing = await readStore(bridge, "profiles");
	assert.equal(missing.status, "missing");
	const beforeWrite = await writeTargetRevision(bridge, "profiles");

	const outcome = await setConfig(bridge, { store: "profiles", data: profilesFixture(), expectedRevision: beforeWrite });

	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.equal(outcome.data.changed, true);
	assert.equal(outcome.data.status, "ok");
	assert.notEqual(outcome.data.writeRevision, beforeWrite);
	assert.equal(readFileSync(path, "utf8"), serializeProfilesFile(normalizeProfilesFile(profilesFixture())!.file));
});

test("profile_fallbacks writes normalized chains and refuses content the owner would drop", async (t) => {
	const env = isolatedEnvironment(t);
	const path = fallbacksFilePath(env.configHome);
	const bridge = bridgeFor(env);
	const data = {
		kind: FALLBACKS_KIND,
		version: FALLBACKS_VERSION,
		profiles: { team: { worker: [{ model: "openai/gpt-fallback", thinking: "low" }] } },
	};
	const empty = await readStore(bridge, "profile_fallbacks");

	const outcome = await setConfig(bridge, {
		store: "profile_fallbacks",
		data,
		expectedRevision: await writeTargetRevision(bridge, "profile_fallbacks"),
	});

	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.equal(outcome.data.scope, "global");
	assert.equal(outcome.data.writeTarget, "global");
	assert.equal(outcome.data.changed, true);
	assert.notEqual(outcome.data.revision, empty.revision);
	assert.deepEqual(outcome.data.value.profiles.team.worker, [{ model: "openai/gpt-fallback", thinking: "low" }]);
	assert.equal(
		readFileSync(path, "utf8"),
		`${JSON.stringify(normalizeFallbacksFile(data), null, 2)}\n`,
		"the store holds exactly the owner-normalized chains",
	);
	assert.equal(outcome.event?.name, "config_changed");

	const before = snapshotTree(env.root);
	for (const invalid of [
		{ kind: FALLBACKS_KIND, version: FALLBACKS_VERSION, profiles: { team: { worker: [] } } },
		{ kind: FALLBACKS_KIND, version: FALLBACKS_VERSION, profiles: { team: { worker: [{ model: "openai/gpt-a" }, { model: "openai/gpt-a" }] } } },
		{ kind: FALLBACKS_KIND, version: FALLBACKS_VERSION, profiles: { team: { worker: [{ model: "not a model" }] } } },
		{ kind: FALLBACKS_KIND, version: FALLBACKS_VERSION, profiles: {}, extra: true },
		{ kind: "gentle-pi.something_else", version: 1, profiles: {} },
	]) {
		const rejected = await setConfig(bridge, {
			store: "profile_fallbacks",
			data: invalid,
			expectedRevision: await writeTargetRevision(bridge, "profile_fallbacks"),
		});
		assertError(rejected, "invalid_data");
	}
	assert.deepEqual(snapshotTree(env.root), before, "rejected data never touches the store");
});

test("pins writes only the layer the request names", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const identity: WorktreeIdentity = { root: env.workspace, commonDir: join(env.root, "git-common") };
	const bridge = bridgeFor(env, () => identity);
	const targets = (await readStore(bridge, "pins")).writeTargets;
	assert.deepEqual(
		targets.map((entry: any) => [entry.target, entry.status]),
		[["local", "missing"], ["repo", "missing"]],
		"both owner layers are write targets before either file exists",
	);

	const local = await setConfig(bridge, {
		store: "pins",
		data: { source: "local", profile: "ops" },
		expectedRevision: targets[0].writeRevision,
	});

	assert.equal(local.ok, true, JSON.stringify(local));
	assert.equal(local.data.scope, "local+repo");
	assert.equal(local.data.writeTarget, "local");
	assert.equal(local.data.changed, true);
	assert.deepEqual(local.data.value.winner, { source: "local", profile: "ops" });
	assert.equal(readFileSync(localProfilePinPath(identity.commonDir), "utf8"), serializeProfilePin("ops"));
	assert.equal(existsSync(repoProfileDeclarationPath(identity.root)), false, "the other layer is untouched");
	assert.equal(local.event?.name, "config_changed");
	assert.equal(local.event?.data.writeTarget, "local");
	assert.equal(JSON.stringify(local.data).includes(env.root), false, "no pin path crosses the contract");

	const afterLocal = await readStore(bridge, "pins");
	const repo = await setConfig(bridge, {
		store: "pins",
		data: { source: "repo", profile: "team" },
		expectedRevision: afterLocal.writeTargets[1].writeRevision,
	});

	assert.equal(repo.ok, true, JSON.stringify(repo));
	assert.equal(repo.data.writeTarget, "repo");
	assert.equal(repo.data.changed, true);
	assert.equal(readFileSync(repoProfileDeclarationPath(identity.root), "utf8"), serializeProfilePin("team"));
	assert.equal(readFileSync(localProfilePinPath(identity.commonDir), "utf8"), serializeProfilePin("ops"));
	assert.deepEqual(repo.data.value.winner, { source: "local", profile: "ops" }, "the local layer still wins the read");
});

test("stale or missing expectedRevision is a revision conflict without writes", async (t) => {
	const env = isolatedEnvironment(t);
	const path = profilesFilePath(env.configHome);
	writeJson(path, profilesFixture());
	const bridge = bridgeFor(env);
	const revision = await writeTargetRevision(bridge, "profiles");
	const data = { ...profilesFixture(), active: "ops" };
	const before = snapshotTree(env.root);

	for (const expectedRevision of [undefined, 42, "sha256:00000000000000000000000000000000"]) {
		const params: Record<string, unknown> = { store: "profiles", data };
		if (expectedRevision !== undefined) params.expectedRevision = expectedRevision;
		assertError(await setConfig(bridge, params), "revision_conflict");
	}
	assert.deepEqual(snapshotTree(env.root), before, "a conflict never writes");

	const applied = await setConfig(bridge, { store: "profiles", data, expectedRevision: revision });
	assert.equal(applied.ok, true, JSON.stringify(applied));
	const stale = await setConfig(bridge, { store: "profiles", data: profilesFixture(), expectedRevision: revision });
	assertError(stale, "revision_conflict");
	assert.equal((await readStore(bridge, "profiles")).value.active, "ops", "the stale write never applied");
});

test("invalid data never creates or modifies a file", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const identity: WorktreeIdentity = { root: env.workspace, commonDir: join(env.root, "git-common") };
	const bridge = bridgeFor(env, () => identity);
	const before = snapshotTree(env.root);
	const cases: Array<[string, unknown]> = [
		["profiles", []],
		["profiles", { kind: "gentle-pi.something_else", version: 1, profiles: {} }],
		["profiles", { kind: PROFILES_KIND, version: PROFILES_VERSION, profiles: { "bad name": { worker: { model: "openai/gpt-a" } } } }],
		["profiles", { kind: PROFILES_KIND, version: PROFILES_VERSION, profiles: { team: { "bad agent!": { model: "openai/gpt-a" } } } }],
		["profiles", { ...profilesFixture(), active: "ghost" }],
		["profiles", { ...profilesFixture(), profiles: { team: { explore: { model: "openai/gpt-a", effort: "high" } } } }],
		["profiles", { ...profilesFixture(), profiles: { team: { explore: { model: "openai/gpt-a", unknown_member: 1 } } } }],
		["profiles", { ...profilesFixture(), workflow: { team: { orchestratorMode: "organic" } } }],
		["profile_fallbacks", { kind: FALLBACKS_KIND, version: FALLBACKS_VERSION, profiles: { team: { worker: [{ model: "openai/gpt-a" }, { model: "openai/gpt-a" }] } } }],
		["pins", { source: "local", profile: "ghost" }],
		["pins", { source: "global", profile: "team" }],
		["pins", { source: "local", profile: "bad name" }],
		["pins", { profile: "team" }],
		["pins", { source: "local", profile: "team", path: "/etc/passwd" }],
		["pins", "local"],
	];
	for (const [store, data] of cases) {
		const revision = await writeTargetRevision(bridge, store, store === "pins" ? "local" : "global");
		const outcome = await setConfig(bridge, { store, data, expectedRevision: revision });
		assertError(outcome, "invalid_data");
		assert.equal(JSON.stringify(outcome).includes("/etc/passwd"), false, "no path is echoed back");
	}
	assert.deepEqual(snapshotTree(env.root), before, "no rejected write creates or modifies a store");
});

test("read-only and unknown stores reject writes without creating anything", async (t) => {
	const env = isolatedEnvironment(t);
	const bridge = bridgeFor(env);
	const before = snapshotTree(env.root);

	for (const store of ["models", "subagents", "managed_assets"]) {
		const outcome = await setConfig(bridge, { store, data: {}, expectedRevision: "sha256:x" });
		assertError(outcome, "read_only");
	}
	assertError(await setConfig(bridge, { store: "auth", data: {}, expectedRevision: "sha256:x" }), "unknown_store");
	assert.deepEqual(snapshotTree(env.root), before, "no read-only store is created or materialized");
});

test("set_config rejects extra keys, missing data, and physical paths", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const bridge = bridgeFor(env);
	const revision = await writeTargetRevision(bridge, "profiles");
	const data = { ...profilesFixture(), active: "ops" };
	const before = snapshotTree(env.root);

	for (const params of [
		{ store: "profiles", data, expectedRevision: revision, path: join(env.configHome, "profiles.json") },
		{ store: "profiles", data, expectedRevision: revision, scope: "global" },
		{ store: "profiles", data, expectedRevision: revision, file: "profiles.json" },
		{ store: "profiles", data, expectedRevision: revision, physical_path: "/etc/passwd" },
		{ store: "profiles", expectedRevision: revision },
		{ store: 42, data, expectedRevision: revision },
	]) {
		const outcome = await setConfig(bridge, params as Record<string, unknown>);
		assertError(outcome, "invalid_request");
		assert.equal(JSON.stringify(outcome).includes(env.root), false, "no physical path is echoed back");
	}
	assert.deepEqual(snapshotTree(env.root), before, "a malformed request never writes");
});

test("an identical write is a no-op with untouched bytes and no event", async (t) => {
	const env = isolatedEnvironment(t);
	const path = profilesFilePath(env.configHome);
	writeJson(path, profilesFixture());
	const bridge = bridgeFor(env);
	const before = { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };

	const outcome = await setConfig(bridge, {
		store: "profiles",
		data: profilesFixture(),
		expectedRevision: await writeTargetRevision(bridge, "profiles"),
	});

	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.equal(outcome.data.changed, false);
	assert.equal(outcome.data.readOnly, false);
	assert.equal(outcome.data.status, "ok");
	assert.equal(outcome.event, undefined, "a no-op emits no event");
	assert.deepEqual(
		{ text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs },
		before,
		"identical content is not rewritten",
	);
});

test("writes require a bound session with a working directory", async (t) => {
	const env = isolatedEnvironment(t);
	const before = snapshotTree(env.root);
	const bridge = new DesktopConfigBridge({ configHome: env.configHome, agentHome: env.agentHome });
	bridge.attach({ mode: "rpc" } as unknown as ExtensionContext);

	assertError(
		await setConfig(bridge, { store: "profiles", data: profilesFixture(), expectedRevision: "sha256:x" }),
		"config_unavailable",
	);
	assert.equal(bridge.handle("get_permission_mode", {}), undefined, "other domains still fall through");
	assert.equal(bridge.handle("set_permission_mode", { mode: "auto" }), undefined);
	bridge.reset();
	assertError(
		await setConfig(bridge, { store: "profiles", data: profilesFixture(), expectedRevision: "sha256:x" }),
		"config_unavailable",
	);
	assert.deepEqual(snapshotTree(env.root), before, "nothing is written without a session cwd");
});

test("pins write only inside a resolvable worktree", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const bridge = bridgeFor(env, () => undefined);

	assertError(
		await setConfig(bridge, { store: "pins", data: { source: "repo", profile: "team" }, expectedRevision: "sha256:x" }),
		"config_unavailable",
	);
	assertError(
		await setConfig(bridge, { store: "pins", data: { source: "repo", profile: null }, expectedRevision: "sha256:x" }),
		"config_unavailable",
	);
	assert.equal(existsSync(repoProfileDeclarationPath(env.workspace)), false, "no target is invented without a worktree");
});

test("pins clears the layer the request names and reports the remaining store", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const identity: WorktreeIdentity = { root: env.workspace, commonDir: join(env.root, "git-common") };
	writeJson(localProfilePinPath(identity.commonDir), pin("ops"));
	writeJson(repoProfileDeclarationPath(identity.root), pin("team"));
	const bridge = bridgeFor(env, () => identity);
	const repoBytes = readFileSync(repoProfileDeclarationPath(identity.root), "utf8");

	const targets = (await readStore(bridge, "pins")).writeTargets;
	assert.deepEqual(targets.map((entry: any) => [entry.target, entry.status]), [["local", "ok"], ["repo", "ok"]]);

	const cleared = await setConfig(bridge, {
		store: "pins",
		data: { source: "local", profile: null },
		expectedRevision: targets[0].writeRevision,
	});

	assert.equal(cleared.ok, true, JSON.stringify(cleared));
	assert.equal(cleared.data.store, "pins");
	assert.equal(cleared.data.scope, "local+repo");
	assert.equal(cleared.data.readOnly, false);
	assert.equal(cleared.data.writeTarget, "local");
	assert.equal(cleared.data.changed, true);
	assert.deepEqual(cleared.data.value.winner, { source: "repo", profile: "team" }, "the lower layer now resolves");
	assert.deepEqual(cleared.data.layers, [
		{ source: "local", status: "missing" },
		{ source: "repo", status: "ok" },
	]);
	assert.equal(existsSync(localProfilePinPath(identity.commonDir)), false, "the cleared layer file is gone");
	assert.equal(
		readFileSync(repoProfileDeclarationPath(identity.root), "utf8"),
		repoBytes,
		"the layer the request did not name is untouched",
	);
	assert.equal(cleared.event?.name, "config_changed");
	assert.deepEqual(cleared.event?.data, {
		store: "pins",
		scope: "local+repo",
		writeTarget: "local",
		revision: cleared.data.revision,
		writeRevision: cleared.data.writeRevision,
		source: "desktop",
	});
	assert.equal(JSON.stringify(cleared).includes(env.root), false, "no pin path crosses the contract");

	// The repo layer needs its own write revision, and the winner changes again.
	const repoRevision = (await readStore(bridge, "pins")).writeTargets[1].writeRevision;
	const repo = await setConfig(bridge, {
		store: "pins",
		data: { source: "repo", profile: null },
		expectedRevision: repoRevision,
	});
	assert.equal(repo.ok, true, JSON.stringify(repo));
	assert.equal(repo.data.writeTarget, "repo");
	assert.equal(repo.data.changed, true);
	assert.equal(existsSync(repoProfileDeclarationPath(identity.root)), false);
	assert.equal(repo.data.value.resolved, false);
	assert.equal((await readStore(bridge, "pins")).status, "missing");
});

test("clearing an already-missing pin layer is a no-op with no event", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const identity: WorktreeIdentity = { root: env.workspace, commonDir: join(env.root, "git-common") };
	const bridge = bridgeFor(env, () => identity);
	const before = snapshotTree(env.root);

	const outcome = await setConfig(bridge, {
		store: "pins",
		data: { source: "local", profile: null },
		expectedRevision: (await readStore(bridge, "pins")).writeTargets[0].writeRevision,
	});

	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.equal(outcome.data.changed, false);
	assert.equal(outcome.event, undefined, "clearing nothing emits nothing");
	assert.deepEqual(snapshotTree(env.root), before, "a no-op clear creates and removes nothing");

	// A layer that exists but is not a readable pin is still removed by an explicit clear.
	mkdirSync(dirname(localProfilePinPath(identity.commonDir)), { recursive: true });
	writeFileSync(localProfilePinPath(identity.commonDir), "{ broken\n");
	const broken = await setConfig(bridge, {
		store: "pins",
		data: { source: "local", profile: null },
		expectedRevision: (await readStore(bridge, "pins")).writeTargets[0].writeRevision,
	});
	assert.equal(broken.ok, true, JSON.stringify(broken));
	assert.equal(broken.data.changed, true);
	assert.equal(existsSync(localProfilePinPath(identity.commonDir)), false);
});

test("a clear with a stale or missing revision is a conflict without writes", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const identity: WorktreeIdentity = { root: env.workspace, commonDir: join(env.root, "git-common") };
	writeJson(localProfilePinPath(identity.commonDir), pin("ops"));
	writeJson(repoProfileDeclarationPath(identity.root), pin("team"));
	const bridge = bridgeFor(env, () => identity);
	const targets = (await readStore(bridge, "pins")).writeTargets;
	const before = snapshotTree(env.root);
	const repoBytes = readFileSync(repoProfileDeclarationPath(identity.root), "utf8");

	// Another layer's revision is not this layer's precondition.
	assertError(
		await setConfig(bridge, { store: "pins", data: { source: "local", profile: null }, expectedRevision: targets[1].writeRevision }),
		"revision_conflict",
	);
	assertError(
		await setConfig(bridge, { store: "pins", data: { source: "local", profile: null } }),
		"revision_conflict",
	);
	assert.deepEqual(snapshotTree(env.root), before, "a conflicted clear removes nothing");

	const applied = await setConfig(bridge, {
		store: "pins",
		data: { source: "local", profile: null },
		expectedRevision: targets[0].writeRevision,
	});
	assert.equal(applied.ok, true, JSON.stringify(applied));
	assertError(
		await setConfig(bridge, { store: "pins", data: { source: "repo", profile: null }, expectedRevision: targets[0].writeRevision }),
		"revision_conflict",
	);
	assert.equal(
		readFileSync(repoProfileDeclarationPath(identity.root), "utf8"),
		repoBytes,
		"the stale clear left the other layer in place",
	);
});

test("pins rejects a null-clearing shape that is not explicit", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const identity: WorktreeIdentity = { root: env.workspace, commonDir: join(env.root, "git-common") };
	const bridge = bridgeFor(env, () => identity);
	const before = snapshotTree(env.root);
	const revision = (await readStore(bridge, "pins")).writeTargets[0].writeRevision;

	for (const data of [
		{ source: "local" },
		{ source: "local", profile: 7 },
		{ source: "local", profile: "" },
		{ source: "local", profile: "bad name" },
		{ source: "local", profile: [] },
		{ source: "local", profile: "ghost" },
		{ profile: null },
		{ source: "global", profile: null },
		{ source: "local", profile: null, path: "/etc/passwd" },
	]) {
		const outcome = await setConfig(bridge, { store: "pins", data, expectedRevision: revision });
		assertError(outcome, "invalid_data");
		assert.equal(JSON.stringify(outcome).includes("/etc/passwd"), false);
	}
	assert.deepEqual(snapshotTree(env.root), before, "a rejected shape never creates or removes a pin");
});

test("an owner write failure is a typed write_failed with no path and no event", async (t) => {
	const env = isolatedEnvironment(t);
	const path = profilesFilePath(env.configHome);
	// A hostile but real filesystem shape: the store path is a directory, so the
	// owner's atomic rename cannot land and the write throws.
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "marker"), "x");
	const bridge = bridgeFor(env);
	const target = await writeTargetRevision(bridge, "profiles");
	const before = snapshotTree(env.root);

	const outcome = await setConfig(bridge, { store: "profiles", data: profilesFixture(), expectedRevision: target });

	assert.equal(outcome.ok, false, JSON.stringify(outcome));
	assert.equal(outcome.error.code, "write_failed");
	assert.equal(outcome.error.message, "Config store write failed", "the message is fixed, not owner detail");
	assert.equal(outcome.event, undefined, "a failed write emits no event");
	const wire = JSON.stringify(outcome);
	assert.equal(wire.includes(env.root), false, "no physical path leaks");
	for (const leak of ["EISDIR", "ENOTDIR", "EPERM", "EACCES", "EEXIST", "EROFS", "errno", "syscall", "profiles.json"]) {
		assert.equal(wire.includes(leak), false, `no OS detail leaks: ${leak}`);
	}
	assert.deepEqual(snapshotTree(env.root), before, "the failed write leaves the tree exactly as it was, temp file included");
});

test("pins replaces an unreadable layer explicitly, and invalid revisions stay coarse", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const identity: WorktreeIdentity = { root: env.workspace, commonDir: join(env.root, "git-common") };
	const path = localProfilePinPath(identity.commonDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "{ broken\n");
	const bridge = bridgeFor(env, () => identity);
	const targets = (await readStore(bridge, "pins")).writeTargets;
	assert.equal(targets[0].status, "invalid");

	// Two different broken contents share one write revision: the invalid-state digest
	// covers only `{store, target, status}`, so this guard is deliberately coarse.
	writeFileSync(path, "[different, broken]\n");
	const rewritten = (await readStore(bridge, "pins")).writeTargets;
	assert.equal(rewritten[0].writeRevision, targets[0].writeRevision, "broken-to-broken is invisible to the guard");

	const outcome = await setConfig(bridge, {
		store: "pins",
		data: { source: "local", profile: "ops" },
		expectedRevision: targets[0].writeRevision,
	});

	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.equal(outcome.data.changed, true);
	assert.deepEqual(outcome.data.layers, [
		{ source: "local", status: "ok" },
		{ source: "repo", status: "missing" },
	]);
	assert.deepEqual(outcome.data.value.winner, { source: "local", profile: "ops" });
	assert.equal(readFileSync(path, "utf8"), serializeProfilePin("ops"), "the broken layer is replaced, not merged");
	assert.equal(outcome.event?.name, "config_changed");
	assert.equal(outcome.event?.data.writeTarget, "local");
});

test("set_config validates in one documented order", async (t) => {
	const env = isolatedEnvironment(t);
	const bridge = bridgeFor(env);
	const revision = "sha256:00000000000000000000000000000000";
	const before = snapshotTree(env.root);

	// 1. Envelope: exact keys, `store` as a string, and `data` present.
	assertError(await setConfig(bridge, { store: "models" }), "invalid_request");
	assertError(await setConfig(bridge, { store: "auth" }), "invalid_request");
	assertError(await setConfig(bridge, { store: 42, data: {}, expectedRevision: revision }), "invalid_request");
	// 2. Store identity.
	assertError(await setConfig(bridge, { store: "auth", data: {}, expectedRevision: revision }), "unknown_store");
	// 3. Mutability, before the payload is inspected or the revision is read.
	assertError(await setConfig(bridge, { store: "models", data: "not an object", expectedRevision: 42 }), "read_only");
	// 4. A usable revision, before the payload is validated.
	assertError(await setConfig(bridge, { store: "profiles", data: [] }), "revision_conflict");
	assertError(await setConfig(bridge, { store: "profiles", data: [], expectedRevision: "" }), "revision_conflict");
	// 5. Session roots.
	assertError(
		await (async () => {
			const unbound = new DesktopConfigBridge({ configHome: env.configHome, agentHome: env.agentHome });
			unbound.attach({ mode: "rpc" } as unknown as ExtensionContext);
			return setConfig(unbound, { store: "profiles", data: profilesFixture(), expectedRevision: revision });
		})(),
		"config_unavailable",
	);
	// 6. Payload, 7. revision comparison.
	assertError(await setConfig(bridge, { store: "profiles", data: [], expectedRevision: revision }), "invalid_data");
	assertError(await setConfig(bridge, { store: "profiles", data: profilesFixture(), expectedRevision: revision }), "revision_conflict");
	assert.deepEqual(snapshotTree(env.root), before, "no rejected request writes");
});

test("a pin write is not claimed after its worktree disappears", async (t) => {
	const env = isolatedEnvironment(t);
	writeJson(profilesFilePath(env.configHome), profilesFixture());
	const identity: WorktreeIdentity = { root: env.workspace, commonDir: join(env.root, "git-common") };
	let current: WorktreeIdentity | undefined = identity;
	const bridge = bridgeFor(env, () => current);
	const targets = (await readStore(bridge, "pins")).writeTargets;

	const written = await setConfig(bridge, {
		store: "pins",
		data: { source: "local", profile: "ops" },
		expectedRevision: targets[0].writeRevision,
	});
	assert.equal(written.ok, true, JSON.stringify(written));

	// The session survives its worktree: reads must stop claiming a pin target.
	current = undefined;
	const after = await readStore(bridge, "pins");
	assert.equal(after.status, "invalid");
	assert.deepEqual(after.value, { resolved: false, invalid: [], stale: [], reason: "worktree_unresolved" });
	assert.deepEqual(after.writeTargets, [], "no target is reported for a vanished worktree");
	assert.equal(JSON.stringify(after).includes("ops"), false, "no stale pin claim survives the worktree");
	assertError(
		await setConfig(bridge, { store: "pins", data: { source: "local", profile: null }, expectedRevision: written.data.writeRevision }),
		"config_unavailable",
	);
	assert.equal(
		readFileSync(localProfilePinPath(identity.commonDir), "utf8"),
		serializeProfilePin("ops"),
		"the pin file itself is untouched; only the session lost its target",
	);
});

// ---- Transport-level coverage: capabilities, dispatch, and prior slices ----

type WidgetCall = { key: string; lines: string[] };

function isolatedTransport(t: test.TestContext) {
	const env = isolatedEnvironment(t);
	const previous = {
		host: process.env[INTERACTIVE_HOST_ENV],
		configHome: process.env.GENTLE_PI_CONFIG_HOME,
		agentHome: process.env.GENTLE_PI_AGENT_HOME,
	};
	process.env[INTERACTIVE_HOST_ENV] = "1";
	process.env.GENTLE_PI_CONFIG_HOME = env.configHome;
	process.env.GENTLE_PI_AGENT_HOME = env.agentHome;
	t.after(() => {
		const restore = (key: string, value: string | undefined) => {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		};
		restore(INTERACTIVE_HOST_ENV, previous.host);
		restore("GENTLE_PI_CONFIG_HOME", previous.configHome);
		restore("GENTLE_PI_AGENT_HOME", previous.agentHome);
	});

	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const events = new Map<string, (event: unknown, ctx: any) => void>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { events.set(name, handler); },
	} as unknown as ExtensionAPI;
	desktopRpc(pi);
	const widgets: WidgetCall[] = [];
	const ctx = {
		mode: "rpc",
		cwd: env.workspace,
		ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); } },
	};
	return {
		env,
		ctx,
		widgets,
		events,
		start() { events.get("session_start")?.({}, ctx); },
		async invoke(method: string, params: Record<string, unknown> = {}, requestId = `request-${method}`) {
			await commands.get("gentle:desktop")!.handler(
				JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params }),
				ctx,
			);
		},
		last(): any {
			const call = widgets.at(-1)!;
			assert.equal(call.key, DESKTOP_RPC_WIDGET);
			return JSON.parse(call.lines[0]!);
		},
	};
}

test("capabilities advertise the wired config read and write surface", async (t) => {
	const app = isolatedTransport(t);
	app.start();
	await app.invoke("capabilities");
	const response = app.last();
	assert.deepEqual(response.data.methods, [
		"capabilities",
		"get_snapshot",
		"get_config",
		"set_config",
		"get_permission_mode",
		"set_permission_mode",
		"get_subscription_usage",
		"refresh_subscription_usage",
		"get_design_canvas",
		"list_jobs",
		"cancel_job",
		"list_subagents",
		"cancel_subagent",
	]);
	assert.deepEqual(response.data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "agents_update"]);
});

test("get_config answers through the transport with no physical path in the response", async (t) => {
	const app = isolatedTransport(t);
	writeJson(profilesFilePath(app.env.configHome), profilesFixture());
	app.start();

	await app.invoke("get_config", { store: "profiles" });
	const response = app.last();
	assert.equal(response.kind, "response");
	assert.equal(response.ok, true);
	assert.equal(response.data.store, "profiles");
	assert.equal(response.data.status, "ok");
	assert.equal(response.data.readOnly, false);
	assert.match(response.data.revision, /^sha256:[a-f0-9]{32}$/);
	assert.equal(JSON.stringify(response).includes(app.env.root), false);

	await app.invoke("get_config", { store: "profiles", path: "/etc/passwd" });
	const rejected = app.last();
	assert.equal(rejected.ok, false);
	assert.equal(rejected.error.code, "invalid_request");
});

test("the snapshot exposes the config projection and keeps the permission slice working", async (t) => {
	const app = isolatedTransport(t);
	app.start();

	await app.invoke("get_snapshot");
	const snapshot = app.last();
	assert.equal(snapshot.data.schema, DESKTOP_RPC_SCHEMA);
	assert.equal(snapshot.data.sequence, 0);
	assert.deepEqual(
		snapshot.data.state.config.stores.map((entry: any) => entry.store),
		[...DESKTOP_CONFIG_STORES],
	);
	assert.equal(JSON.stringify(snapshot).includes(app.env.root), false);

	// The dispatcher must still fall through to the permission bridge.
	await app.invoke("get_permission_mode");
	const permission = app.last();
	assert.equal(permission.ok, false);
	assert.equal(permission.error.code, "permission_unavailable", "no owner extension in this process");
});

test("set_config answers before exactly one config_changed and the snapshot reflects it", async (t) => {
	const app = isolatedTransport(t);
	writeJson(profilesFilePath(app.env.configHome), profilesFixture());
	app.start();

	await app.invoke("get_config", { store: "profiles" }, "read-1");
	const read = app.last();
	assert.equal(read.ok, true);
	const revision = read.data.writeTargets[0].writeRevision;

	await app.invoke("set_config", { store: "profiles", data: { ...profilesFixture(), active: "ops" }, expectedRevision: revision }, "write-1");
	assert.equal(app.widgets.length, 3, "a read, its response, and one event");
	const response = JSON.parse(app.widgets[1]!.lines[0]!);
	const event = JSON.parse(app.widgets[2]!.lines[0]!);
	assert.equal(response.kind, "response");
	assert.equal(response.requestId, "write-1");
	assert.equal(response.data.changed, true);
	assert.equal(response.data.writeTarget, "global");

	assert.equal(event.kind, "event");
	assert.equal(event.event, "config_changed");
	assert.equal(event.seq, 1);
	assert.deepEqual(event.data, {
		store: "profiles",
		scope: "global",
		writeTarget: "global",
		revision: response.data.revision,
		writeRevision: response.data.writeRevision,
		source: "desktop",
	});
	assert.equal(JSON.stringify([response, event]).includes(app.env.root), false);

	await app.invoke("get_snapshot", {}, "snap-1");
	assert.equal(app.last().data.sequence, 1, "a delivered event advances the sequence");
	assert.equal(app.last().data.state.config.stores[0].status, "ok");

	const published = app.widgets.length;
	await app.invoke("set_config", { store: "profiles", data: profilesFixture(), expectedRevision: revision }, "write-2");
	assert.equal(app.last().error.code, "revision_conflict");
	assert.equal(app.widgets.length, published + 1, "a conflict publishes only its response");
});

test("a stopped session answers nothing and writes nothing", async (t) => {
	const app = isolatedTransport(t);
	writeJson(profilesFilePath(app.env.configHome), profilesFixture());
	app.start();
	await app.invoke("get_config", { store: "profiles" }, "read-1");
	const revision = app.last().data.writeTargets[0].writeRevision;
	const before = snapshotTree(app.env.root);

	app.events.get("session_shutdown")?.({}, app.ctx);
	await app.invoke("set_config", { store: "profiles", data: withProfile("late", "openai/gpt-late"), expectedRevision: revision }, "write-1");

	assert.equal(app.widgets.length, 1, "a stopped router publishes nothing");
	assert.deepEqual(snapshotTree(app.env.root), before, "a stopped session never writes");
});

function snapshotTree(root: string): Record<string, string> {
	const tree: Record<string, string> = {};
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				tree[`${path}/`] = "dir";
				walk(path);
				continue;
			}
			const stat = statSync(path);
			tree[path] = `${stat.size}:${stat.mtimeMs}:${readFileSync(path, "utf8")}`;
		}
	};
	walk(root);
	return tree;
}
