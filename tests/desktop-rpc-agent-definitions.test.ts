import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { DESKTOP_RPC_SCHEMA } from "../lib/desktop-rpc.ts";
import {
	AGENT_DEFINITIONS_UNAVAILABLE,
	DESKTOP_AGENT_DEFINITIONS_EVENTS,
	DESKTOP_AGENT_DEFINITIONS_LIMITS,
	DESKTOP_AGENT_DEFINITIONS_METHODS,
	INVALID_AGENT_DEFINITIONS_PARAMS,
	projectAgentDefinitions,
} from "../lib/desktop-rpc-agent-definitions.ts";
import type { AgentDefinitionsLocationFactory } from "../lib/desktop-agent-definitions-service.ts";
import type { AgentDefinition } from "../lib/agents-config.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// list_agent_definitions: a read over the existing agent discovery
// (`discoverAgents`, `loadAgentsConfig`) and Pi's orchestrator settings
// (`readOrchestratorSettings`). The transport tests run the real owners
// against temporary agent homes and project directories.

interface Fixture {
	root: string;
	agentHome: string;
	cwd: string;
	configHome: string;
	settingsPath: string;
}

function fixture(t: test.TestContext): Fixture {
	const root = mkdtempSync(join(tmpdir(), "desktop-agent-defs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentHome = join(root, "agent-home");
	const cwd = join(root, "project");
	const configHome = join(root, "config-home");
	for (const dir of [join(agentHome, "agents"), join(agentHome, "subagents"), join(cwd, ".pi", "agents"), configHome]) mkdirSync(dir, { recursive: true });
	return { root, agentHome, cwd, configHome, settingsPath: join(agentHome, "settings.json") };
}

function interactiveHost(t: test.TestContext): void {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
}

/** The real Desktop transport on one fake pi, with the definitions read from the fixture. */
function harness(t: test.TestContext, location: AgentDefinitionsLocationFactory) {
	interactiveHost(t);
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut() {},
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { on() { return () => {}; }, emit() {} },
	} as unknown as ExtensionAPI;
	desktopRpc(pi, { agentDefinitionsLocation: location });
	const widgets: string[] = [];
	const ctx = {
		mode: "rpc",
		cwd: "/unused",
		sessionManager: { getCwd: () => "/unused", getSessionId: () => "session-a", getEntries: () => [] },
		ui: { setWidget(_key: string, lines: string[]) { widgets.push(...lines); } },
	};
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	return {
		widgets,
		invoke(requestId: string, params: Record<string, unknown>, method = "list_agent_definitions") {
			return commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params }), ctx);
		},
		last() { return JSON.parse(widgets.at(-1)!); },
	};
}

const locate = (f: Fixture): AgentDefinitionsLocationFactory => () => ({
	roots: { cwd: f.cwd, home: f.root, agentHome: f.agentHome, configHome: f.configHome },
	orchestratorSettingsPath: f.settingsPath,
});

// ---- Capabilities ----

test("the Desktop transport advertises list_agent_definitions once and no new event", async (t) => {
	assert.deepEqual([...DESKTOP_AGENT_DEFINITIONS_METHODS], ["list_agent_definitions"]);
	assert.deepEqual([...DESKTOP_AGENT_DEFINITIONS_EVENTS], []);
	const app = harness(t, locate(fixture(t)));
	await app.invoke("cap-1", {}, "capabilities");
	const response = app.last();
	assert.equal(response.data.methods.filter((method: string) => method === "list_agent_definitions").length, 1);
	assert.ok(response.data.methods.includes("get_update_status"), "the previous methods stay advertised");
	assert.deepEqual(response.data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "profile_applied", "agents_update", "review_mode_changed", "profile_binding_changed"]);
});

// ---- The read ----

test("list_agent_definitions answers the discovered agents, subagent defaults, and the default orchestrator, without paths or prompts", async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.agentHome, "agents", "explore.md"), "---\nname: explore\ndescription: Global explorer.\nmodel: openai-codex/gpt-5.6-terra\nthinking: high\ntools: read, grep\n---\nSECRET PROMPT BODY");
	writeFileSync(join(f.agentHome, "agents", "worker.md"), "---\nname: worker\ndescription: Global worker.\n---\nglobal worker body");
	writeFileSync(join(f.cwd, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: Project worker.\nsubagent_mode: background\n---\nproject worker body");
	writeFileSync(join(f.agentHome, "agents", "broken.md"), "---\nname: broken\nthinking: extreme\n---\nbody");
	writeFileSync(join(f.agentHome, "subagents.json"), JSON.stringify({ default_model: "anthropic/claude-luna", default_mode: "background" }));
	writeFileSync(f.settingsPath, JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.6-terra", defaultThinkingLevel: "medium", theme: "dark" }));
	const app = harness(t, locate(f));
	await app.invoke("defs-1", {});
	const response = app.last();
	assert.equal(response.ok, true);
	assert.deepEqual(response.data, {
		agents: [
			{ name: "explore", description: "Global explorer.", scope: "global", source: "user", model: "openai-codex/gpt-5.6-terra", thinking: "high", mode: null, tools: ["read", "grep"], toolsTruncated: false },
			{ name: "worker", description: "Project worker.", scope: "project", source: "project", model: null, thinking: null, mode: "background", tools: [], toolsTruncated: false },
		],
		truncated: false,
		problems: { invalid: 1, notices: 0 },
		subagentDefaults: { model: "anthropic/claude-luna", thinking: null, mode: "background" },
		defaultOrchestrator: { status: "set", model: "openai-codex/gpt-5.6-terra", thinking: "medium" },
	});
	const raw = app.widgets.at(-1)!;
	assert.equal(raw.includes(f.root.replaceAll("\\", "\\\\")), false, "no path crosses");
	assert.equal(raw.includes("SECRET PROMPT BODY"), false, "no prompt body crosses");
	assert.equal(raw.includes("extreme"), false, "no problem text crosses");
});

test("list_agent_definitions covers the /gentle:profiles roots: built-in package agents, ~/.agents, and <cwd>/.agents, each with its source", async (t) => {
	const f = fixture(t);
	const builtinDir = join(f.root, "package", "agents");
	for (const dir of [builtinDir, join(f.root, ".agents"), join(f.cwd, ".agents")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(builtinDir, "jd-judge-a.md"), "---\nname: jd-judge-a\ndescription: Built-in judge A.\n---\nbody");
	writeFileSync(join(builtinDir, "planner.md"), "---\nname: planner\ndescription: Built-in planner.\n---\nbody");
	writeFileSync(join(f.root, ".agents", "planner.md"), "---\nname: planner\ndescription: User planner.\n---\nbody");
	writeFileSync(join(f.root, ".agents", "helper.md"), "---\nname: helper\ndescription: User helper.\n---\nbody");
	writeFileSync(join(f.cwd, ".agents", "helper.md"), "---\nname: helper\ndescription: Project helper.\n---\nbody");
	writeFileSync(join(f.cwd, ".agents", "local.md"), "---\nname: local\ndescription: Project local.\n---\nbody");
	const app = harness(t, () => ({ ...locate(f)({} as never), builtinDirs: [builtinDir] }));
	await app.invoke("roots-1", {});
	const agents = app.last().data.agents.map((agent: { name: string; description: string; scope: string; source: string }) => ({ name: agent.name, description: agent.description, scope: agent.scope, source: agent.source }));
	assert.deepEqual(agents, [
		{ name: "helper", description: "Project helper.", scope: "project", source: "project" },
		{ name: "jd-judge-a", description: "Built-in judge A.", scope: "global", source: "builtin" },
		{ name: "local", description: "Project local.", scope: "project", source: "project" },
		{ name: "planner", description: "User planner.", scope: "global", source: "user" },
	]);
});

test("the default orchestrator reports missing, unset, and invalid settings by status only", async (t) => {
	const f = fixture(t);
	const app = harness(t, locate(f));
	await app.invoke("orch-missing", {});
	assert.deepEqual(app.last().data.defaultOrchestrator, { status: "missing", model: null, thinking: null });
	writeFileSync(f.settingsPath, JSON.stringify({ theme: "dark" }));
	await app.invoke("orch-unset", {});
	assert.deepEqual(app.last().data.defaultOrchestrator, { status: "unset", model: null, thinking: null });
	writeFileSync(f.settingsPath, "{ not json");
	await app.invoke("orch-invalid", {});
	assert.deepEqual(app.last().data.defaultOrchestrator, { status: "invalid", model: null, thinking: null });
	assert.equal(app.widgets.at(-1)!.includes("settings.json"), false, "the parser reason never crosses");
});

test("an empty install answers no agents and the built-in subagent defaults", async (t) => {
	const app = harness(t, locate(fixture(t)));
	await app.invoke("empty-1", {});
	const data = app.last().data;
	assert.deepEqual(data.agents, []);
	assert.equal(data.truncated, false);
	assert.deepEqual(data.problems, { invalid: 0, notices: 0 });
	assert.deepEqual(data.subagentDefaults, { model: null, thinking: null, mode: "task" });
});

// ---- Errors ----

test("list_agent_definitions rejects any param as invalid_request", async (t) => {
	let located = 0;
	const f = fixture(t);
	const app = harness(t, () => { located += 1; return locate(f)(undefined as never); });
	await app.invoke("bad-1", { scope: "project" });
	assert.deepEqual(app.last(), { schema: DESKTOP_RPC_SCHEMA, kind: "response", requestId: "bad-1", ok: false, error: INVALID_AGENT_DEFINITIONS_PARAMS });
	assert.equal(located, 0, "a malformed request never reads");
});

test("a failing read answers agent_definitions_unavailable without its message", async (t) => {
	const app = harness(t, () => { throw new Error("EACCES: C:\\Users\\secret\\.pi\\agent\\agents"); });
	await app.invoke("fail-1", {});
	assert.deepEqual(app.last(), { schema: DESKTOP_RPC_SCHEMA, kind: "response", requestId: "fail-1", ok: false, error: AGENT_DEFINITIONS_UNAVAILABLE });
	assert.equal(app.widgets.at(-1)!.includes("secret"), false);
});

// ---- Bounds ----

test("the projection bounds the agent list and each agent's tools", () => {
	const agent = (index: number): AgentDefinition => ({
		name: `agent-${String(index).padStart(3, "0")}`,
		description: "d",
		filePath: `/home/x/.pi/agent/agents/agent-${index}.md`,
		scope: "global",
		instructions: "body",
		model: undefined,
		thinking: undefined,
		mode: undefined,
		tools: Array.from({ length: DESKTOP_AGENT_DEFINITIONS_LIMITS.tools + 1 }, (_, tool) => `tool-${tool}`),
	});
	const result = projectAgentDefinitions({
		agents: Array.from({ length: DESKTOP_AGENT_DEFINITIONS_LIMITS.agents + 1 }, (_, index) => agent(index)),
		errors: [],
		notices: [],
		defaults: { model: undefined, thinking: undefined, mode: "task" },
		orchestrator: { status: "missing" },
	});
	assert.equal(result.agents.length, DESKTOP_AGENT_DEFINITIONS_LIMITS.agents);
	assert.equal(result.truncated, true);
	assert.equal(result.agents[0]!.tools.length, DESKTOP_AGENT_DEFINITIONS_LIMITS.tools);
	assert.equal(result.agents[0]!.toolsTruncated, true);
	assert.equal(JSON.stringify(result).includes("/home/x"), false);
});
