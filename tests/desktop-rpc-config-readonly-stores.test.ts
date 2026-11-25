import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DESKTOP_CONFIG_STORES, DesktopConfigBridge, configWatchTargets } from "../lib/desktop-rpc-config.ts";

// The read-only `mcp`, `pi_settings`, and `claude_bridge` config stores
// (gentle-shell-gpui parity, round 2): display projections of files Pi or a
// third-party package own. Every test runs in an isolated temporary root and
// plants secret-shaped values that must never reach the wire.

const SECRET_TOKEN = "sk-live-SECRET-TOKEN-0123456789";
const SECRET_HEADER = "Bearer HEADER-SECRET-abcdef";
const ABSOLUTE_PATH = process.platform === "win32" ? "C:\\Users\\someone\\secret-dir\\tool.js" : "/home/someone/secret-dir/tool.js";

function env(t: test.TestContext, options: { trusted?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "desktop-config-readonly-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const configHome = join(root, "config");
	const agentHome = join(root, "agent");
	const workspace = join(root, "workspace");
	for (const dir of [configHome, agentHome, workspace]) mkdirSync(dir, { recursive: true });
	const bridge = new DesktopConfigBridge({ configHome, agentHome });
	const trusted = options.trusted ?? true;
	bridge.attach({ cwd: workspace, isProjectTrusted: () => trusted } as unknown as ExtensionContext);
	return {
		root,
		agentHome,
		workspace,
		bridge,
		async read(store: string): Promise<any> {
			const outcome = await bridge.handle("get_config", { store });
			assert.ok(outcome?.ok, JSON.stringify(outcome));
			return outcome.data;
		},
	};
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function assertNoLeak(answer: unknown, root: string, extra: string[] = []): void {
	const wire = JSON.stringify(answer);
	for (const secret of [SECRET_TOKEN, SECRET_HEADER, ABSOLUTE_PATH, JSON.stringify(ABSOLUTE_PATH).slice(1, -1), root, JSON.stringify(root).slice(1, -1), "secret-dir", ...extra]) {
		assert.equal(wire.includes(secret), false, `the answer leaks ${secret}: ${wire}`);
	}
}

// ---- store list ----

test("the store list keeps every existing store in order and appends the read-only display stores", () => {
	assert.deepEqual([...DESKTOP_CONFIG_STORES], [
		"profiles",
		"models",
		"profile_fallbacks",
		"subagents",
		"pins",
		"managed_assets",
		"persona",
		"banner",
		"notifications",
		"mcp",
		"pi_settings",
		"claude_bridge",
	]);
});

test("set_config refuses every new store as read_only and writes nothing", async (t) => {
	const e = env(t);
	for (const store of ["mcp", "pi_settings", "claude_bridge"]) {
		const outcome = await e.bridge.handle("set_config", { store, data: {}, expectedRevision: "sha256:x" });
		assert.equal(outcome?.ok, false, JSON.stringify(outcome));
		assert.equal((outcome as { error: { code: string } }).error.code, "read_only");
		const read = await e.read(store);
		assert.equal(read.readOnly, true);
		assert.equal(read.writeTargets, undefined, "a read-only store reports no write target");
		assert.equal(read.status, "missing", "a refused write creates nothing");
	}
});

test("the owner files of the new stores are watched for external changes", async (t) => {
	const e = env(t);
	const targets = configWatchTargets({ cwd: e.workspace, configHome: join(e.root, "config"), agentHome: e.agentHome, projectTrusted: true });
	const has = (dir: string, name: string) => targets.some((target) => target.dir === dir && target.names.includes(name));
	assert.ok(has(e.agentHome, "mcp.json"));
	assert.ok(has(join(e.workspace, ".pi"), "mcp.json"));
	assert.ok(has(e.agentHome, "settings.json"));
	assert.ok(has(join(e.workspace, ".pi"), "settings.json"));
	assert.ok(has(e.agentHome, "claude-bridge.json"));
});

// ---- mcp ----

test("mcp lists name, transport, and enabled only, never env, headers, args, command, url, or cwd", async (t) => {
	const e = env(t);
	writeJson(join(e.agentHome, "mcp.json"), {
		mcpServers: {
			filesystem: { command: "npx", args: ["-y", ABSOLUTE_PATH], env: { API_TOKEN: SECRET_TOKEN }, cwd: ABSOLUTE_PATH },
			docs: { url: "https://user:pass@docs.example.com/mcp", headers: { Authorization: SECRET_HEADER }, enabled: false },
			sentry: { type: "http", url: "https://mcp.sentry.example/mcp", oauth: { clientSecret: SECRET_TOKEN } },
		},
	});
	const data = await e.read("mcp");
	assert.equal(data.store, "mcp");
	assert.equal(data.scope, "global+project");
	assert.equal(data.readOnly, true);
	assert.equal(data.status, "ok");
	assert.deepEqual(data.layers, [{ source: "global", status: "ok" }, { source: "project", status: "missing" }]);
	assert.deepEqual(data.value, {
		servers: [
			{ name: "filesystem", transport: "stdio", enabled: true },
			{ name: "docs", transport: "http", enabled: false },
			{ name: "sentry", transport: "http", enabled: true },
		],
		truncated: false,
		omitted: 0,
	});
	assertNoLeak(data, e.root, ["npx", "docs.example.com", "user:pass", "mcp.sentry.example", "API_TOKEN", "Authorization"]);
});

test("mcp merges a trusted project file like Pi: replacements, enabled-only overrides, and new servers", async (t) => {
	const e = env(t);
	writeJson(join(e.agentHome, "mcp.json"), {
		mcpServers: {
			internal: { url: "https://internal.example/mcp", headers: { Authorization: SECRET_HEADER } },
			shared: { command: "global-cmd" },
		},
	});
	writeJson(join(e.workspace, ".pi", "mcp.json"), {
		mcpServers: {
			internal: { enabled: false },
			shared: { url: "https://project.example/mcp" },
			local: { command: "project-cmd", env: { TOKEN: SECRET_TOKEN } },
			orphan: { enabled: true },
			risky: { url: "https://risky.example/mcp", auth: { provider: "anthropic" } },
		},
	});
	const data = await e.read("mcp");
	assert.deepEqual(data.layers, [{ source: "global", status: "ok" }, { source: "project", status: "ok" }]);
	assert.deepEqual(data.value.servers, [
		{ name: "internal", transport: "http", enabled: false },
		{ name: "shared", transport: "http", enabled: true },
		{ name: "local", transport: "stdio", enabled: true },
	], "an override without a global server and a project `auth` server are skipped, exactly as Pi skips them");
	assertNoLeak(data, e.root, ["internal.example", "project-cmd", "TOKEN"]);
});

test("mcp ignores the project file of an untrusted project, as Pi does", async (t) => {
	const e = env(t, { trusted: false });
	writeJson(join(e.agentHome, "mcp.json"), { mcpServers: { a: { command: "a" } } });
	writeJson(join(e.workspace, ".pi", "mcp.json"), { mcpServers: { b: { command: "b" } } });
	const data = await e.read("mcp");
	assert.deepEqual(data.layers, [{ source: "global", status: "ok" }], "an untrusted project layer is not read at all");
	assert.deepEqual(data.value.servers, [{ name: "a", transport: "stdio", enabled: true }]);
});

test("mcp reports missing and malformed files by status, never by a raw error or path", async (t) => {
	const e = env(t);
	const missing = await e.read("mcp");
	assert.equal(missing.status, "missing");
	assert.equal(missing.value, undefined);
	writeFileSync(join(e.agentHome, "mcp.json"), `{ "mcpServers": { "x": { "env": { "K": "${SECRET_TOKEN}" } `);
	const malformed = await e.read("mcp");
	assert.equal(malformed.status, "invalid");
	assert.equal(malformed.value, undefined);
	assert.deepEqual(malformed.layers, [{ source: "global", status: "invalid" }, { source: "project", status: "missing" }]);
	assertNoLeak(malformed, e.root);
});

test("mcp caps the server list and reports the cut", async (t) => {
	const e = env(t);
	const servers = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`server-${index}`, { command: "x" }]));
	writeJson(join(e.agentHome, "mcp.json"), { mcpServers: servers });
	const data = await e.read("mcp");
	assert.equal(data.value.servers.length, 64);
	assert.equal(data.value.truncated, true);
	assert.equal(data.value.omitted, 0);
});

test("mcp counts over-long server names as omitted, never as a cut at the bound", async (t) => {
	const e = env(t);
	const long = "n".repeat(129);
	writeJson(join(e.agentHome, "mcp.json"), { mcpServers: { [long]: { command: "x" }, short: { command: "y" } } });
	const data = await e.read("mcp");
	assert.deepEqual(data.value, { servers: [{ name: "short", transport: "stdio", enabled: true }], truncated: false, omitted: 1 });
	assertNoLeak(data, e.root, [long]);
});

test("mcp reports the transport Pi connects with for an entry with both command and url", async (t) => {
	const e = env(t);
	writeJson(join(e.agentHome, "mcp.json"), { mcpServers: { both: { command: "x", url: "https://x.example/mcp" }, typed: { type: "stdio", command: "x", url: "https://y.example/mcp" } } });
	const data = await e.read("mcp");
	assert.deepEqual(data.value.servers, [
		{ name: "both", transport: "http", enabled: true },
		{ name: "typed", transport: "http", enabled: true },
	]);
});

// ---- pi_settings ----

test("pi_settings projects only the default model and thinking, enabled models, and extensions", async (t) => {
	const e = env(t);
	writeJson(join(e.agentHome, "settings.json"), {
		defaultProvider: "anthropic",
		defaultModel: "claude-sonnet-4",
		defaultThinkingLevel: "high",
		enabledModels: ["anthropic/claude-*", "openai/gpt-5"],
		packages: ["npm:gentle-pi@1.2.3", { source: "npm:@scope/tool@1", extensions: [ABSOLUTE_PATH] }, ABSOLUTE_PATH, "git:github.com/acme/pkg@v1"],
		extensions: [ABSOLUTE_PATH, "./local/my-ext.ts"],
		theme: "dark",
		sessionDir: ABSOLUTE_PATH,
		npmCommand: [ABSOLUTE_PATH],
		shellPath: ABSOLUTE_PATH,
		apiKey: SECRET_TOKEN,
	});
	const data = await e.read("pi_settings");
	assert.equal(data.store, "pi_settings");
	assert.equal(data.scope, "global+project");
	assert.equal(data.readOnly, true);
	assert.equal(data.status, "ok");
	assert.deepEqual(data.layers, [{ source: "global", status: "ok" }, { source: "project", status: "missing" }]);
	assert.deepEqual(data.value, {
		defaultProvider: "anthropic",
		defaultModel: "claude-sonnet-4",
		defaultThinkingLevel: "high",
		enabledModels: ["anthropic/claude-*", "openai/gpt-5"],
		extensions: ["tool.js", "my-ext.ts"],
		truncated: false,
	}, "packages (get_update_status), theme, and sessionDir are not part of this store");
	assertNoLeak(data, e.root, ["apiKey", "npmCommand", "shellPath", "local/", "gentle-pi", "@scope/tool", "github.com/acme", "dark", "sessionDir", "packages", "theme"]);
});

test("pi_settings merges a trusted project file over the global one, as Pi does", async (t) => {
	const e = env(t);
	writeJson(join(e.agentHome, "settings.json"), { defaultProvider: "anthropic", defaultModel: "claude-sonnet-4" });
	writeJson(join(e.workspace, ".pi", "settings.json"), { defaultModel: "claude-opus-4", defaultThinkingLevel: "low" });
	const data = await e.read("pi_settings");
	assert.deepEqual(data.layers, [{ source: "global", status: "ok" }, { source: "project", status: "ok" }]);
	assert.equal(data.value.defaultProvider, "anthropic");
	assert.equal(data.value.defaultModel, "claude-opus-4");
	assert.equal(data.value.defaultThinkingLevel, "low");
	assert.equal(data.value.enabledModels, null, "no enabledModels setting means no restriction");
});

test("pi_settings ignores an untrusted project file", async (t) => {
	const e = env(t, { trusted: false });
	writeJson(join(e.agentHome, "settings.json"), { defaultModel: "claude-sonnet-4" });
	writeJson(join(e.workspace, ".pi", "settings.json"), { defaultModel: "project-model" });
	const data = await e.read("pi_settings");
	assert.deepEqual(data.layers, [{ source: "global", status: "ok" }]);
	assert.equal(data.value.defaultModel, "claude-sonnet-4");
});

test("pi_settings reports missing and malformed files by status, never a raw error or path", async (t) => {
	const e = env(t);
	const missing = await e.read("pi_settings");
	assert.equal(missing.status, "missing");
	assert.equal(missing.value, undefined);
	writeFileSync(join(e.agentHome, "settings.json"), `{ "sessionDir": "${JSON.stringify(ABSOLUTE_PATH).slice(1, -1)}", `);
	const malformed = await e.read("pi_settings");
	assert.equal(malformed.status, "invalid");
	assert.equal(malformed.value, undefined);
	assertNoLeak(malformed, e.root);
});

test("pi_settings bounds its lists and drops values that look like paths", async (t) => {
	const e = env(t);
	writeJson(join(e.agentHome, "settings.json"), {
		defaultModel: ABSOLUTE_PATH,
		defaultThinkingLevel: "ultra-secret",
		enabledModels: Array.from({ length: 100 }, (_, index) => `provider/model-${index}`),
	});
	const data = await e.read("pi_settings");
	assert.equal(data.value.defaultModel, null);
	assert.equal(data.value.defaultThinkingLevel, null, "only Pi's thinking levels pass");
	assert.equal(data.value.enabledModels.length, 64);
	assert.equal(data.value.truncated, true);
	assertNoLeak(data, e.root);
});

test("pi_settings never displays credential-shaped or path-shaped model values, but keeps Pi model ids", async (t) => {
	const e = env(t);
	for (const [setting, expected] of [
		[{ defaultProvider: "user:secret@host", defaultModel: "user:secret@host" }, { defaultProvider: null, defaultModel: null }],
		[{ defaultProvider: "a/b", defaultModel: "/home/u/model" }, { defaultProvider: null, defaultModel: null }],
		[{ defaultProvider: "openai", defaultModel: "./rel/model" }, { defaultProvider: "openai", defaultModel: null }],
		[{ defaultProvider: "openrouter", defaultModel: "openrouter/anthropic/claude-3.5-sonnet" }, { defaultProvider: "openrouter", defaultModel: "openrouter/anthropic/claude-3.5-sonnet" }],
		[{ defaultProvider: "openai", defaultModel: "..\\x\\y" }, { defaultProvider: "openai", defaultModel: null }],
		[{ defaultProvider: "openrouter", defaultModel: "anthropic/claude-3.5-sonnet" }, { defaultProvider: "openrouter", defaultModel: "anthropic/claude-3.5-sonnet" }],
		[{ defaultProvider: "openai", defaultModel: "gpt-5.1-codex" }, { defaultProvider: "openai", defaultModel: "gpt-5.1-codex" }],
	] as const) {
		writeJson(join(e.agentHome, "settings.json"), setting);
		const data = await e.read("pi_settings");
		assert.deepEqual({ defaultProvider: data.value.defaultProvider, defaultModel: data.value.defaultModel }, expected, JSON.stringify(setting));
	}
	writeJson(join(e.agentHome, "settings.json"), { enabledModels: ["openai/gpt-5", "anthropic/*:high", "claude-sonnet-4", "openrouter/anthropic/*", "user:secret@host", "/abs/model", "./rel/path", "../up/model", "x\\y"] });
	const data = await e.read("pi_settings");
	assert.deepEqual(data.value.enabledModels, ["openai/gpt-5", "anthropic/*:high", "claude-sonnet-4", "openrouter/anthropic/*"]);
	assertNoLeak(data, e.root, ["secret@host", "/abs/model", "rel/path", "up/model"]);
});

test("a settings value Pi cannot read keeps an absent project layer missing", async (t) => {
	for (const settings of [{ sessionDir: 7 }, { extensions: { a: "x" } }]) {
		const e = env(t);
		writeJson(join(e.agentHome, "settings.json"), settings);
		const data = await e.read("pi_settings");
		assert.equal(data.layers[1]?.source, "project");
		assert.deepEqual(data.layers[1], { source: "project", status: "missing" }, JSON.stringify(settings));
		assertNoLeak(data, e.root);
	}
});

test("pi_settings drops extension names that are too long, credential-shaped, or not a plain file name", async (t) => {
	const e = env(t);
	const long = `${"e".repeat(129)}.ts`;
	writeJson(join(e.agentHome, "settings.json"), {
		extensions: [`./ext/${long}`, "https://user:secret@host.example/ext.ts", "user:secret@host", "./ext/bad\u0007name.ts", "./ext/ok-ext.ts", "plain.js"],
	});
	const data = await e.read("pi_settings");
	assert.deepEqual(data.value.extensions, ["ok-ext.ts", "plain.js"]);
	assertNoLeak(data, e.root, [long.slice(0, 40), "secret@host", "user:secret", "bad"]);
});

test("pi_settings shows no extensions when a hand-edited extensions value is a string, not a list", async (t) => {
	for (const extensions of ["C:\\Users\\devel\\secretdir\\ext.ts", "./secretdir/ext.ts", "hunter2"]) {
		const e = env(t);
		writeJson(join(e.agentHome, "settings.json"), { extensions });
		const data = await e.read("pi_settings");
		assert.deepEqual(data.value?.extensions ?? [], [], extensions);
		assertNoLeak(data, e.root, ["secretdir", "hunter2"]);
		assert.ok(!JSON.stringify(data).includes('"h","u"'), extensions);
	}
});

// ---- claude_bridge ----

test("claude_bridge exposes only the plan of an existing claude-bridge.json", async (t) => {
	const e = env(t);
	writeJson(join(e.agentHome, "claude-bridge.json"), {
		provider: { plan: "max", apiKey: SECRET_TOKEN, cliPath: ABSOLUTE_PATH },
		token: SECRET_TOKEN,
		extra: { anything: "else-secret-value" },
	});
	const data = await e.read("claude_bridge");
	assert.equal(data.store, "claude_bridge");
	assert.equal(data.scope, "global");
	assert.equal(data.readOnly, true);
	assert.equal(data.status, "ok");
	assert.deepEqual(data.layers, [{ source: "global", status: "ok" }]);
	assert.deepEqual(data.value, { plan: "max" });
	assertNoLeak(data, e.root, ["else-secret-value", "apiKey", "cliPath"]);
});

test("claude_bridge is missing when the file is absent and never echoes an unknown plan", async (t) => {
	const e = env(t);
	const missing = await e.read("claude_bridge");
	assert.equal(missing.status, "missing");
	assert.equal(missing.value, undefined);
	writeJson(join(e.agentHome, "claude-bridge.json"), { provider: {} });
	assert.deepEqual((await e.read("claude_bridge")).value, { plan: null });
	writeJson(join(e.agentHome, "claude-bridge.json"), { provider: { plan: ABSOLUTE_PATH } });
	const odd = await e.read("claude_bridge");
	assert.deepEqual(odd.value, { plan: null });
	assertNoLeak(odd, e.root);
	writeFileSync(join(e.agentHome, "claude-bridge.json"), `{ "token": "${SECRET_TOKEN}"`);
	const malformed = await e.read("claude_bridge");
	assert.equal(malformed.status, "invalid");
	assert.equal(malformed.value, undefined);
	assertNoLeak(malformed, e.root);
});

test("reading the display stores never writes: no lock file, no created file, no rewrite", async (t) => {
	const e = env(t);
	const files = {
		[join(e.agentHome, "settings.json")]: `{ "defaultModel": "m", "queueMode": "all" }\n`,
		[join(e.workspace, ".pi", "settings.json")]: `{ "defaultThinkingLevel": "low" }\n`,
		[join(e.agentHome, "mcp.json")]: `{ "mcpServers": { "a": { "command": "a" } } }\n`,
		[join(e.agentHome, "claude-bridge.json")]: `{ "provider": { "plan": "pro" } }\n`,
	};
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	}
	const listing = () => [e.agentHome, join(e.workspace, ".pi")].map((dir) => readdirSync(dir).sort().join(","));
	const before = listing();
	for (const store of ["mcp", "pi_settings", "claude_bridge"]) await e.read(store);
	e.bridge.snapshotState();
	assert.deepEqual(listing(), before);
	for (const [path, text] of Object.entries(files)) assert.equal(readFileSync(path, "utf8"), text, "a migration Pi would save is never written back");
});

test("a project trust change seen on the next Desktop command re-reads the trust-gated stores once", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "desktop-config-readonly-trust-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentHome = join(root, "agent");
	const workspace = join(root, "workspace");
	writeJson(join(workspace, ".pi", "mcp.json"), { mcpServers: { local: { command: "x", env: { TOKEN: SECRET_TOKEN } } } });
	mkdirSync(agentHome, { recursive: true });
	const bridge = new DesktopConfigBridge({ configHome: join(root, "config"), agentHome });
	t.after(() => bridge.reset());
	let trusted = false;
	const context = { cwd: workspace, isProjectTrusted: () => trusted } as unknown as ExtensionContext;
	const events: Array<Record<string, unknown>> = [];
	bridge.attach(context);
	bridge.wire((_event, data) => events.push(data));

	bridge.attach(context);
	assert.deepEqual(events, [], "an unchanged trust answer re-reads nothing");
	trusted = true;
	bridge.attach(context);
	assert.deepEqual(events.map((event) => [event.store, event.status, event.source]), [["mcp", "ok", "external"]]);
	bridge.attach(context);
	assert.equal(events.length, 1, "the new trust answer is the baseline");
	assertNoLeak(events, root);
});

test("a trust answer read by a recompute becomes the baseline, so reverting it is still reported", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "desktop-config-readonly-trust-recompute-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentHome = join(root, "agent");
	const workspace = join(root, "workspace");
	writeJson(join(workspace, ".pi", "mcp.json"), { mcpServers: { local: { command: "x" } } });
	mkdirSync(agentHome, { recursive: true });
	const changes: Array<() => void> = [];
	const timers: Array<() => void> = [];
	const bridge = new DesktopConfigBridge(
		{ configHome: join(root, "config"), agentHome },
		{
			watch: (_dir: string, onChange: (filename: string | undefined) => void) => {
				changes.push(() => onChange(undefined));
				return () => {};
			},
			timers: { set: (fn: () => void) => timers.push(fn), clear: () => {} },
			exists: () => true,
		},
	);
	t.after(() => bridge.reset());
	let trusted = false;
	const context = { cwd: workspace, isProjectTrusted: () => trusted } as unknown as ExtensionContext;
	const events: Array<Record<string, unknown>> = [];
	bridge.attach(context);
	bridge.wire((_event, data) => events.push(data));

	// Trust changes with no Desktop command; a file change then recomputes with the new answer.
	trusted = true;
	changes[0]?.();
	timers.splice(0).forEach((fn) => fn());
	assert.deepEqual(events.map((event) => event.store), ["mcp"], "the recompute reports the trusted project layer");

	// Trust reverts before the next Desktop command: that command must still re-read.
	trusted = false;
	bridge.attach(context);
	assert.deepEqual(events.map((event) => event.store), ["mcp", "mcp"], "the reverted trust answer is reported");
});
