import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { getPackageDir, ModelRegistry, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DesktopConfigBridge } from "../lib/desktop-rpc-config.ts";
import { SECRET_MARKER } from "../lib/pi-user-config.ts";

// Pi's own custom models (`<agentHome>/models.json`, `custom_models`) and MCP
// servers (`<agentHome>/mcp.json`, `<cwd>/.pi/mcp.json`, `mcp`) as config
// stores: clients read and write them through get_config/set_config, never the
// files, and never see a secret. Every home is a temp directory.

type Watch = { dir: string; onChange: (filename: string | undefined) => void };

function env(t: test.TestContext, context: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), "desktop-config-pi-files-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const configHome = join(root, "config");
	const agentHome = join(root, "agent");
	const workspace = join(root, "workspace");
	for (const dir of [configHome, agentHome, workspace]) mkdirSync(dir, { recursive: true });
	const watches: Watch[] = [];
	const debounced: Array<() => void> = [];
	const bridge = new DesktopConfigBridge({ configHome, agentHome }, {
		// The debounce window closes when the test says so (`elapse`), never on the wall clock.
		timers: {
			set: (fn) => {
				debounced.push(fn);
				return fn;
			},
			clear: (handle) => {
				const index = debounced.indexOf(handle as () => void);
				if (index !== -1) debounced.splice(index, 1);
			},
		},
		watch: (dir, onChange) => {
			const watch = { dir, onChange };
			watches.push(watch);
			return () => watches.splice(watches.indexOf(watch), 1);
		},
	});
	const ctx = { cwd: workspace, ...context } as unknown as ExtensionContext;
	bridge.attach(ctx);
	return {
		root,
		agentHome,
		workspace,
		bridge,
		ctx,
		watches,
		/** Closes every open debounce window, then lets the owner re-reads finish. */
		async elapse(): Promise<void> {
			for (const fn of debounced.splice(0)) fn();
			await ticks();
		},
		models: join(agentHome, "models.json"),
		globalMcp: join(agentHome, "mcp.json"),
		projectMcp: join(workspace, ".pi", "mcp.json"),
		async read(store: string): Promise<any> {
			const outcome = await bridge.handle("get_config", { store });
			assert.ok(outcome?.ok, JSON.stringify(outcome));
			return outcome.data;
		},
		async revision(store: string, target = "global"): Promise<string> {
			return (await this.read(store)).writeTargets.find((entry: any) => entry.target === target).writeRevision;
		},
		async write(store: string, data: unknown, expectedRevision?: string): Promise<any> {
			const target = store === "mcp" && (data as any)?.source === "project" ? "project" : "global";
			return bridge.handle("set_config", { store, data, expectedRevision: expectedRevision ?? await this.revision(store, target) });
		},
	};
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
}

/** Lets queued owner work (`setImmediate`, settled promises) run; no wall-clock wait. */
async function ticks(): Promise<void> {
	for (let index = 0; index < 10; index += 1) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

const PROVIDER = {
	baseUrl: "http://127.0.0.1:11434/v1",
	api: "openai-completions",
	apiKey: "sk-local-secret",
	headers: { "X-Team": "team-secret" },
	models: [
		{ id: "llama-big", headers: { "X-Model": "model-secret" } },
		{ id: "llama-small", contextWindow: 32000 },
	],
	modelOverrides: { "llama-big": { headers: { "X-Override": "override-secret" } } },
};

// ---- custom_models ----

test("custom models read Pi's models.json as Pi does, with every secret redacted", async (t) => {
	const e = env(t);
	const empty = await e.read("custom_models");
	assert.deepEqual([empty.status, empty.scope, empty.readOnly, empty.value], ["missing", "global", false, undefined]);
	assert.deepEqual(empty.layers, [{ source: "global", status: "missing" }]);
	// Pi accepts `//` comments and trailing commas in models.json.
	writeFileSync(e.models, `{\n  // local models\n  "providers": { "local": ${JSON.stringify(PROVIDER)}, },\n}\n`);
	const read = await e.read("custom_models");
	assert.equal(read.status, "ok");
	assert.deepEqual(read.value, {
		providers: {
			local: {
				...PROVIDER,
				apiKey: SECRET_MARKER,
				headers: { "X-Team": SECRET_MARKER },
				models: [{ id: "llama-big", headers: { "X-Model": SECRET_MARKER } }, { id: "llama-small", contextWindow: 32000 }],
				modelOverrides: { "llama-big": { headers: { "X-Override": SECRET_MARKER } } },
			},
		},
	});
	assert.equal(JSON.stringify(read).includes("secret\""), false, "no secret crosses");
	writeJson(e.models, { providers: { local: { ...PROVIDER, apiKey: "sk-rotated" } } });
	assert.notEqual((await e.read("custom_models")).revision, read.revision, "a secret changed elsewhere moves the revision");
	writeJson(e.models, { providers: { local: { models: [{ id: "" }] } } });
	const invalid = await e.read("custom_models");
	assert.deepEqual([invalid.status, invalid.value], ["invalid", undefined], "Pi's schema refuses an empty model id");
});

test("a custom models write keeps redacted secrets in place and replaces the file atomically", async (t) => {
	const e = env(t);
	writeJson(e.models, { providers: { local: PROVIDER } });
	const read = await e.read("custom_models");
	const local = read.value.providers.local;
	// Reordered models still keep their own headers: models are matched by id.
	const data = { providers: { local: { ...local, name: "Local", models: [local.models[1], local.models[0]], headers: { "X-Team": "new-team" } } } };
	const outcome = await e.write("custom_models", data);
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.deepEqual([outcome.data.changed, outcome.data.writeTarget, outcome.event?.name, outcome.event?.data.source], [true, "global", "config_changed", "desktop"]);
	assert.deepEqual(outcome.data.value, { providers: { local: { ...data.providers.local, headers: { "X-Team": SECRET_MARKER } } } }, "the answer is the re-read store, a new secret redacted too");
	const written = JSON.parse(readFileSync(e.models, "utf8"));
	assert.equal(written.providers.local.apiKey, "sk-local-secret");
	assert.deepEqual(written.providers.local.headers, { "X-Team": "new-team" });
	assert.deepEqual(written.providers.local.models, [PROVIDER.models[1], PROVIDER.models[0]]);
	assert.deepEqual(written.providers.local.modelOverrides, PROVIDER.modelOverrides);
	if (process.platform !== "win32") assert.equal(statSync(e.models).mode & 0o777, 0o600, "a file holding keys is owner-only");
	const same = await e.write("custom_models", outcome.data.value);
	assert.deepEqual([same.ok, same.data.changed, same.event], [true, false, undefined]);
});

test("a custom models write is refused when Pi would refuse it, or when a marker has nothing to keep", async (t) => {
	const e = env(t);
	for (const [data, message] of [
		[{}, /providers/],
		[{ providers: { local: { models: [{ id: "" }] } } }, /providers\.local\.models\.0\.id/],
		[{ providers: { local: { apiKey: 3 } } }, /providers\.local\.apiKey/],
		[{ providers: { local: { apiKey: SECRET_MARKER } } }, /providers\.local\.apiKey: "•••" keeps a stored value/],
		[[], /root/],
	] as const) {
		const outcome = await e.write("custom_models", data);
		assert.equal(outcome.error?.code, "invalid_data", JSON.stringify(data));
		assert.match(outcome.error.message, message);
		assert.match(outcome.error.message, /^Invalid custom_models data: /);
	}
	assert.equal(existsSync(e.models), false);
	const stale = await e.revision("custom_models");
	writeJson(e.models, { providers: {} });
	assert.equal((await e.write("custom_models", { providers: { x: { models: [] } } }, stale)).error?.code, "revision_conflict");
	const unproven = await e.bridge.handle("set_config", { store: "custom_models", data: { providers: {} } });
	assert.equal(unproven?.ok === false ? unproven.error.code : undefined, "revision_conflict", "a write without expectedRevision proves nothing");
	// An unreadable file is replaced whole: nothing of it is kept.
	writeFileSync(e.models, "{ not json");
	assert.equal((await e.read("custom_models")).status, "invalid");
	assert.equal((await e.write("custom_models", { providers: {} })).ok, true);
	assert.deepEqual(JSON.parse(readFileSync(e.models, "utf8")), { providers: {} });
});

test("a custom models write refreshes the session's model registry before answering", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "desktop-config-registry-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentHome = join(root, "agent");
	mkdirSync(agentHome, { recursive: true });
	const runtime = await ModelRuntime.create({
		authPath: join(agentHome, "auth.json"),
		modelsPath: join(agentHome, "models.json"),
		modelsStorePath: join(agentHome, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const registry = new ModelRegistry(runtime);
	const bridge = new DesktopConfigBridge({ configHome: join(root, "config"), agentHome });
	bridge.attach({ cwd: root, modelRegistry: registry } as unknown as ExtensionContext);
	assert.equal(registry.find("desk-local", "desk-model"), undefined);
	const read: any = await bridge.handle("get_config", { store: "custom_models" });
	const outcome: any = await bridge.handle("set_config", {
		store: "custom_models",
		data: { providers: { "desk-local": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "local", models: [{ id: "desk-model" }] } } },
		expectedRevision: read.data.writeTargets[0].writeRevision,
	});
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.ok(registry.find("desk-local", "desk-model"), "the new custom model is in the registry at once");
});

test("an outside models.json edit emits config_changed and refreshes the registry; an outside mcp.json edit emits config_changed", async (t) => {
	let refreshes = 0;
	const e = env(t, { modelRegistry: { refresh: async () => { refreshes += 1; } }, isProjectTrusted: () => true });
	const events: any[] = [];
	mkdirSync(join(e.workspace, ".pi"), { recursive: true });
	e.bridge.wire((event, data) => events.push({ event, data }));
	writeJson(e.models, { providers: {} });
	for (const watch of e.watches.filter((entry) => entry.dir === e.agentHome)) watch.onChange("models.json");
	await e.elapse();
	assert.deepEqual(events.map((entry) => [entry.event, entry.data.store, entry.data.source, entry.data.status]), [["config_changed", "custom_models", "external", "ok"]]);
	assert.equal(refreshes, 1);
	assert.equal(JSON.stringify(events).includes(e.root), false, "no path on the wire");
	writeJson(e.projectMcp, { mcpServers: { tool: { command: "node" } } });
	for (const watch of e.watches.filter((entry) => entry.dir === join(e.workspace, ".pi"))) watch.onChange("mcp.json");
	await e.elapse();
	assert.deepEqual(events.slice(1).map((entry) => [entry.data.store, entry.data.scope, entry.data.source]), [["mcp", "global+project", "external"]]);
	assert.equal(refreshes, 1, "only a models change refreshes the registry");
});

// ---- mcp ----

const GLOBAL_MCP = {
	autoEnableCodemode: false,
	mcpServers: {
		files: { command: "npx", args: ["-y", "server-filesystem", "."], env: { TOKEN: "env-secret", HOME_DIR: "${HOME}" } },
		docs: { url: "https://docs.example/mcp", headers: { Authorization: "Bearer header-secret" }, oauth: { clientId: "id", clientSecret: "oauth-secret" } },
	},
};

test("the mcp store lists the servers Pi loads and each layer Pi reads whole, secrets redacted", async (t) => {
	const e = env(t);
	const empty = await e.read("mcp");
	assert.deepEqual([empty.status, empty.scope, empty.readOnly, empty.value], ["missing", "global+project", false, undefined]);
	assert.deepEqual(empty.writeTargets.map((entry: any) => [entry.target, entry.status]), [["global", "missing"]], "an untrusted project's file is no write target");
	writeJson(e.globalMcp, GLOBAL_MCP);
	writeJson(e.projectMcp, { mcpServers: { files: { enabled: false } } });
	const read = await e.read("mcp");
	assert.equal(read.status, "ok");
	assert.deepEqual(read.value, {
		servers: [{ name: "files", transport: "stdio", enabled: true }, { name: "docs", transport: "http", enabled: true }],
		truncated: false,
		omitted: 0,
		documents: {
			global: {
				autoEnableCodemode: false,
				mcpServers: {
					files: { ...GLOBAL_MCP.mcpServers.files, env: { TOKEN: SECRET_MARKER, HOME_DIR: SECRET_MARKER } },
					docs: { ...GLOBAL_MCP.mcpServers.docs, headers: { Authorization: SECRET_MARKER }, oauth: { clientId: "id", clientSecret: SECRET_MARKER } },
				},
			},
		},
	}, "Pi does not read an untrusted project's mcp.json, so neither does the store");
	assert.deepEqual(read.layers, [{ source: "global", status: "ok" }]);
	const trusted = env(t, { isProjectTrusted: () => true });
	writeJson(trusted.projectMcp, { mcpServers: { files: { enabled: false } } });
	const project = await trusted.read("mcp");
	assert.deepEqual(project.value, { servers: [], truncated: false, omitted: 0, documents: { project: { mcpServers: { files: { enabled: false } } } } });
	assert.deepEqual(project.writeTargets.map((entry: any) => [entry.target, entry.status]), [["global", "missing"], ["project", "ok"]]);
	writeFileSync(trusted.globalMcp, JSON.stringify({ mcpServers: [] }));
	const layers = (await trusted.read("mcp")).layers;
	assert.deepEqual(layers, [{ source: "global", status: "invalid" }, { source: "project", status: "ok" }]);
	// A secret changed outside moves the revision even though the client never sees it.
	writeJson(e.globalMcp, { ...GLOBAL_MCP, mcpServers: { ...GLOBAL_MCP.mcpServers, files: { ...GLOBAL_MCP.mcpServers.files, env: { TOKEN: "rotated", HOME_DIR: "${HOME}" } } } });
	const rotated = await e.read("mcp");
	assert.deepEqual(rotated.value, read.value);
	assert.notEqual(rotated.revision, read.revision);
});

test("an MCP write replaces one layer, keeps redacted secrets of the same server, and reloads the session once idle", async (t) => {
	let reloads = 0;
	let idleWaits = 0;
	const e = env(t, { waitForIdle: async () => { idleWaits += 1; }, reload: async () => { reloads += 1; } });
	writeJson(e.globalMcp, GLOBAL_MCP);
	const read = await e.read("mcp");
	const document = structuredClone(read.value.documents.global);
	document.mcpServers.files.env.EXTRA = "extra-value";
	document.mcpServers.docs.headers = { Authorization: SECRET_MARKER, "X-New": "new" };
	document.mcpServers.search = { url: "https://search.example/mcp", exposure: "direct" };
	const outcome = await e.write("mcp", { source: "global", document });
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.deepEqual([outcome.data.writeTarget, outcome.data.changed, outcome.event?.data.writeTarget], ["global", true, "global"]);
	const written = JSON.parse(readFileSync(e.globalMcp, "utf8"));
	assert.deepEqual(written.mcpServers.files.env, { TOKEN: "env-secret", HOME_DIR: "${HOME}", EXTRA: "extra-value" });
	assert.deepEqual(written.mcpServers.docs.headers, { Authorization: "Bearer header-secret", "X-New": "new" });
	assert.equal(written.mcpServers.docs.oauth.clientSecret, "oauth-secret");
	assert.equal(written.autoEnableCodemode, false, "other keys are the client's document");
	assert.equal(reloads, 0, "the reload waits until the answer is out");
	await ticks();
	assert.deepEqual([idleWaits, reloads], [1, 1]);
	// What the reloaded session loads: Pi's own MCP loader over the same home (not in Pi's exports, so loaded by path).
	const { loadMcpConfig } = await import(pathToFileURL(join(getPackageDir(), "dist", "extensions", "mcp", "config.js")).href);
	const loaded = loadMcpConfig({ agentDir: e.agentHome, cwd: e.workspace, projectTrusted: false });
	assert.deepEqual(loaded.errors, []);
	assert.deepEqual(loaded.servers.map((server: any) => server.name), ["files", "docs", "search"]);
	assert.equal(loaded.servers.find((server: any) => server.name === "docs").config.headers.Authorization, "Bearer header-secret");
	const same = await e.write("mcp", { source: "global", document: outcome.data.value.documents.global });
	assert.deepEqual([same.ok, same.data.changed], [true, false]);
	await ticks();
	assert.equal(reloads, 1, "no change, no reload");
	// A marker moved to another server has nothing to keep there.
	const moved = await e.write("mcp", { source: "global", document: { mcpServers: { other: { command: "x", env: { TOKEN: SECRET_MARKER } } } } });
	assert.equal(moved.error?.code, "invalid_data");
	assert.match(moved.error.message, /mcpServers\.other\.env\.TOKEN/);
});

test("an MCP write is checked as Pi loads each layer, and a project layer only for a trusted project", async (t) => {
	const untrusted = env(t);
	const refused = await untrusted.bridge.handle("set_config", { store: "mcp", data: { source: "project", document: { mcpServers: {} } }, expectedRevision: "sha256:any" });
	assert.deepEqual(refused, { ok: false, error: { code: "project_untrusted", message: "Pi reads this project's files only once the project is trusted" } });
	assert.equal(existsSync(untrusted.projectMcp), false);
	const e = env(t, { isProjectTrusted: () => true });
	writeJson(e.globalMcp, GLOBAL_MCP);
	for (const [data, message] of [
		[{ source: "global", document: { mcpServers: { broken: { args: ["x"] } } } }, /broken/],
		[{ source: "global", document: { mcpServers: { tool: { command: "x", env: { A: 1 } } } } }, /tool/],
		[{ source: "global", document: { mcpServers: { "my-tool": { command: "x" }, my_tool: { command: "y" } } } }, /conflicts/],
		[{ source: "global", document: { mcpServers: [] } }, /mcpServers/],
		[{ source: "global", document: { autoEnableCodemode: "yes" } }, /autoEnableCodemode/],
		[{ source: "project", document: { mcpServers: { unknown: { enabled: false } } } }, /global server to override/],
		[{ source: "project", document: { mcpServers: { files: { enabled: false, description: "x" } } } }, /an override can only set/],
		[{ source: "project", document: { mcpServers: { api: { url: "https://api.example/mcp", auth: { provider: "anthropic" } } } } }, /auth is only allowed in the global/],
	] as const) {
		const outcome = await e.write("mcp", data);
		assert.equal(outcome.error?.code, "invalid_data", JSON.stringify(data));
		assert.match(outcome.error.message, message);
	}
	for (const data of [{ document: {} }, { source: "local", document: {} }, { source: "global" }, { source: "global", document: {}, path: "/tmp/x" }]) {
		assert.equal((await e.write("mcp", data)).error?.code, "invalid_data", JSON.stringify(data));
	}
	assert.equal(existsSync(e.projectMcp), false);
	const override = await e.write("mcp", { source: "project", document: { mcpServers: { files: { enabled: false, exposure: "direct" } } } });
	assert.equal(override.ok, true, JSON.stringify(override));
	assert.deepEqual(JSON.parse(readFileSync(e.projectMcp, "utf8")), { mcpServers: { files: { enabled: false, exposure: "direct" } } });
	// Each layer has its own write revision: a global token cannot write the project file.
	const globalToken = await e.revision("mcp", "global");
	assert.equal((await e.write("mcp", { source: "project", document: { mcpServers: {} } }, globalToken)).error?.code, "revision_conflict");
});
