import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
	AGENT_MODE,
	THINKING_LEVEL,
	agentDirectories,
	discoverAgents,
	loadAgentsConfig,
	parseAgentDefinition,
	parseAgentsConfig,
	parseFrontmatter,
	parseModelRef,
	resolveAgentProfile,
} from "../lib/agents-config.ts";
import { THINKING_LEVELS } from "../lib/model-routing-authority.ts";

// Gentle Agents configuration: markdown agent definitions (the same files
// gentle-ai installs) and subagents.json, both parsed without touching pi.

const root = mkdtempSync(join(tmpdir(), "gentle-agents-config-"));
after(() => rmSync(root, { recursive: true, force: true }));

const EXPLORER = `---
name: gentle-ai-explore
description: Read-only exploration and mapping.
model: openai-codex/gpt-5.6-terra
thinking: high
tools:
  - read
  - grep
  - codegraph
---

You are the read-only explorer.
Map files and return a compressed handoff.
`;

test("parseFrontmatter reads scalars, inline lists, and block lists, and keeps the body", () => {
	const { data, body } = parseFrontmatter("---\nname: a\ntools: [read, grep]\nlist:\n  - one\n  - two\nquoted: \"x: y\"\n---\nBody here\n");
	assert.deepEqual(data, { name: "a", tools: ["read", "grep"], list: ["one", "two"], quoted: "x: y" });
	assert.equal(body, "Body here");
	assert.deepEqual(parseFrontmatter("no frontmatter"), { data: {}, body: "no frontmatter" });
});

test("parseModelRef splits provider/id and accepts a bare id", () => {
	assert.deepEqual(parseModelRef("openai-codex/gpt-5.6-terra"), { provider: "openai-codex", id: "gpt-5.6-terra" });
	assert.deepEqual(parseModelRef("sonnet"), { provider: undefined, id: "sonnet" });
	assert.equal(parseModelRef("   "), undefined);
});

test("parseAgentDefinition builds a definition from the gentle-ai agent format", () => {
	const agent = parseAgentDefinition(EXPLORER, "/home/x/.pi/agent/agents/gentle-ai-explore.md", "global");
	assert.ok(!("error" in agent));
	assert.equal(agent.name, "gentle-ai-explore");
	assert.equal(agent.description, "Read-only exploration and mapping.");
	assert.deepEqual(agent.model, { provider: "openai-codex", id: "gpt-5.6-terra" });
	assert.equal(agent.thinking, "high");
	assert.deepEqual(agent.tools, ["read", "grep", "codegraph"]);
	assert.equal(agent.mode, undefined);
	assert.equal(agent.scope, "global");
	assert.match(agent.instructions, /^You are the read-only explorer\./);
});

test("parseAgentDefinition accepts effort and subagent_mode aliases, csv tools, and names from the file", () => {
	const agent = parseAgentDefinition("---\ndescription: d\neffort: low\nsubagent_mode: background\ntools: read, bash\n---\nbody", "/p/.pi/agents/worker.md", "project");
	assert.ok(!("error" in agent));
	assert.equal(agent.name, "worker");
	assert.equal(agent.thinking, "low");
	assert.equal(agent.mode, AGENT_MODE.BACKGROUND);
	assert.deepEqual(agent.tools, ["read", "bash"]);
});

test("parseAgentDefinition rejects unknown thinking levels, modes, and empty bodies", () => {
	assert.match((parseAgentDefinition("---\nname: a\nthinking: extreme\n---\nbody", "/a.md", "global") as { error: string }).error, /thinking "extreme"/);
	assert.match((parseAgentDefinition("---\nname: a\nsubagent_mode: forever\n---\nbody", "/a.md", "global") as { error: string }).error, /mode "forever"/);
	assert.match((parseAgentDefinition("---\nname: a\n---\n   \n", "/a.md", "global") as { error: string }).error, /no instructions/);
});

test("runtime thinking levels stay aligned with model routing authority", () => {
	assert.deepEqual(Object.values(THINKING_LEVEL), THINKING_LEVELS);
	assert.equal(THINKING_LEVEL.MAX, "max");
});

test("parseAgentDefinition accepts max through every thinking alias", () => {
	for (const field of ["thinking", "effort", "thinking_level"]) {
		const agent = parseAgentDefinition(`---\nname: worker\n${field}: max\n---\nbody`, "/worker.md", "global");
		assert.ok(!("error" in agent), `${field} must accept max`);
		assert.equal(agent.thinking, "max");
	}
});

test("discoverAgents retains max definitions instead of falling back to medium", () => {
	const home = join(root, "max-home");
	const cwd = join(root, "max-project");
	const agentHome = join(home, ".pi", "agent");
	for (const dir of ["agents", "subagents"]) mkdirSync(join(agentHome, dir), { recursive: true });
	writeFileSync(join(agentHome, "agents", "worker.md"), "---\nname: worker\nthinking: medium\n---\nlegacy worker");
	writeFileSync(join(agentHome, "subagents", "worker.md"), "---\nname: worker\nthinking: max\n---\nselected worker");
	writeFileSync(join(agentHome, "subagents.json"), JSON.stringify({ model_profiles: { worker: { model: "openai-codex/gpt-5.6-luna", effort: "max" } } }));
	const { agents, errors } = discoverAgents({ cwd, home });
	assert.deepEqual(errors, []);
	assert.equal(agents.length, 1);
	assert.equal(agents[0].thinking, "max");
	assert.equal(agents[0].instructions, "selected worker");
	const resolved = resolveAgentProfile(agents[0], loadAgentsConfig({ cwd, home }));
	assert.equal(resolved.model?.id, "gpt-5.6-luna");
	assert.equal(resolved.thinking, "max");
	assert.equal(resolved.source.thinking, "profile");
});

test("max defaults and model profiles preserve routing precedence", () => {
	const bare = parseAgentDefinition("---\nname: worker\n---\nbody", "/worker.md", "global");
	const medium = parseAgentDefinition("---\nname: worker\nthinking: medium\n---\nbody", "/worker.md", "global");
	assert.ok(!("error" in bare));
	assert.ok(!("error" in medium));
	for (const field of ["default_effort", "default_thinking_level", "default_thinking"]) {
		const config = parseAgentsConfig({ [field]: "max" }, undefined);
		assert.equal(config.defaultThinking, "max");
		assert.equal(resolveAgentProfile(bare, config).thinking, "max");
		assert.equal(resolveAgentProfile(bare, config).source.thinking, "default");
		assert.equal(resolveAgentProfile(medium, config).thinking, "medium");
	}
	for (const field of ["effort", "thinking"]) {
		const global = { model_profiles: { worker: { [field]: "max" } } };
		const config = parseAgentsConfig(global, { model_profiles: { worker: { model: "openai-codex/gpt-5.6-luna" } } });
		assert.equal(config.modelProfiles.worker.thinking, "max");
		assert.equal(resolveAgentProfile(medium, config).thinking, "max");
		assert.equal(resolveAgentProfile(medium, config).source.thinking, "profile");
	}
	const override = parseAgentsConfig(
		{ model_profiles: { worker: { model: "openai-codex/gpt-5.6-luna", effort: "high" } } },
		{ model_profiles: { worker: { effort: "max" } } },
	);
	assert.equal(override.modelProfiles.worker.thinking, "max");
	assert.equal(resolveAgentProfile(medium, override).thinking, "max");
	assert.equal(resolveAgentProfile(medium, override).model?.id, "gpt-5.6-luna");
});

test("discoverAgents merges the four directories with project over global and subagents over agents", () => {
	const home = join(root, "home");
	const cwd = join(root, "project");
	for (const dir of [".pi/agent/agents", ".pi/agent/subagents"]) mkdirSync(join(home, dir), { recursive: true });
	for (const dir of [".pi/agents", ".pi/subagents"]) mkdirSync(join(cwd, dir), { recursive: true });
	writeFileSync(join(home, ".pi/agent/agents/explore.md"), EXPLORER);
	writeFileSync(join(home, ".pi/agent/agents/shared.md"), "---\ndescription: global agents\n---\nglobal");
	writeFileSync(join(home, ".pi/agent/subagents/shared.md"), "---\ndescription: global subagents\n---\nglobal sub");
	writeFileSync(join(cwd, ".pi/agents/shared.md"), "---\ndescription: project agents\n---\nproject");
	writeFileSync(join(cwd, ".pi/agents/broken.md"), "---\nthinking: nope\n---\nx");
	writeFileSync(join(cwd, ".pi/agents/notes.txt"), "ignored");
	const { agents, errors } = discoverAgents({ cwd, home });
	assert.deepEqual(agents.map((agent) => `${agent.name}:${agent.description}:${agent.scope}`), ["gentle-ai-explore:Read-only exploration and mapping.:global", "shared:project agents:project"]);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /broken\.md/);
	assert.deepEqual(discoverAgents({ cwd: join(root, "empty"), home: join(root, "nohome") }), { agents: [], errors: [] });
});

test("profile agent roots isolate global definitions and subagents.json while explicit homes keep their fallback", () => {
	const cwd = join(root, "profile-project");
	const principal = join(root, "pi-principal", "agent");
	const lab = join(root, "pi-lab", "agent");
	for (const [agentHome, name, model] of [[principal, "principal", "openai/principal"], [lab, "lab", "openai/lab"]] as const) {
		mkdirSync(join(agentHome, "agents"), { recursive: true });
		writeFileSync(join(agentHome, "agents", `${name}.md`), `---\ndescription: ${name}\n---\n${name}`);
		writeFileSync(join(agentHome, "subagents.json"), JSON.stringify({ default_model: model }));
	}
	assert.deepEqual(agentDirectories({ cwd, home: join(root, "legacy-home"), agentHome: principal }).slice(0, 2).map(({ dir }) => dir), [join(principal, "agents"), join(principal, "subagents")]);
	assert.deepEqual(discoverAgents({ cwd, home: join(root, "legacy-home"), agentHome: principal }).agents.map((agent) => agent.name), ["principal"]);
	assert.deepEqual(discoverAgents({ cwd, home: join(root, "legacy-home"), agentHome: lab }).agents.map((agent) => agent.name), ["lab"]);
	assert.equal(loadAgentsConfig({ cwd, home: join(root, "legacy-home"), agentHome: principal }).defaultModel?.id, "principal");
	assert.equal(loadAgentsConfig({ cwd, home: join(root, "legacy-home"), agentHome: lab }).defaultModel?.id, "lab");
	assert.equal(agentDirectories({ cwd, home: join(root, "legacy-home") })[0].dir, join(root, "legacy-home", ".pi", "agent", "agents"));
});

test("parseAgentsConfig applies defaults, validates values, and silently ignores the retired total-timeout key", () => {
	const config = parseAgentsConfig({ default_model: "openai-codex/gpt-6-astra", default_effort: "medium", max_concurrency: 3, timeout_ms: 1000, stall_timeout_ms: 12_000, model_profiles: { explore: { model: "openai-codex/gpt-5.6-terra", effort: "high" } } }, { max_concurrency: 2, timeout_ms: 500, model_profiles: { explore: { effort: "low" }, worker: { model: "anthropic/claude-sonnet-5" } } });
	assert.deepEqual(config.defaultModel, { provider: "openai-codex", id: "gpt-6-astra" });
	assert.equal(config.defaultThinking, "medium");
	assert.equal(config.maxConcurrency, 2);
	assert.equal(config.stallTimeoutMs, 12_000);
	assert.equal("timeoutMs" in config, false, "legacy timeout_ms must not become an active runtime setting");
	assert.deepEqual(config.modelProfiles.explore, { model: { provider: "openai-codex", id: "gpt-5.6-terra" }, thinking: "low" });
	assert.deepEqual(config.modelProfiles.worker, { model: { provider: "anthropic", id: "claude-sonnet-5" }, thinking: undefined });
	const defaults = parseAgentsConfig(undefined, undefined);
	assert.equal(defaults.maxConcurrency, 5);
	assert.equal("timeoutMs" in defaults, false);
	assert.equal(defaults.stallTimeoutMs, 4 * 60_000);
	assert.equal(defaults.defaultMode, AGENT_MODE.TASK);
	assert.equal(defaults.historyMaxTasks, 200);
	assert.equal(parseAgentsConfig({ max_concurrency: "many", default_effort: "wild", default_mode: "background" }, undefined).maxConcurrency, 5);
	assert.equal(parseAgentsConfig({ default_mode: "background" }, undefined).defaultMode, AGENT_MODE.BACKGROUND);
});

test("parseAgentsConfig resolves the tool-call stall ceiling above the idle silence budget", () => {
	const defaults = parseAgentsConfig(undefined, undefined);
	assert.equal(defaults.stallTimeoutMs, 4 * 60_000);
	assert.equal(defaults.toolStallTimeoutMs, 30 * 60_000);
	const explicit = parseAgentsConfig({ stall_timeout_ms: 12_000, tool_stall_timeout_ms: 20 * 60_000 }, undefined);
	assert.equal(explicit.stallTimeoutMs, 12_000);
	assert.equal(explicit.toolStallTimeoutMs, 20 * 60_000);
	const projectWins = parseAgentsConfig({ tool_stall_timeout_ms: 20 * 60_000 }, { tool_stall_timeout_ms: 15 * 60_000 });
	assert.equal(projectWins.toolStallTimeoutMs, 15 * 60_000);
	for (const invalid of ["forever", 0, -1, 12.5, null]) {
		assert.equal(parseAgentsConfig({ tool_stall_timeout_ms: invalid }, undefined).toolStallTimeoutMs, 30 * 60_000, `invalid tool_stall_timeout_ms ${String(invalid)} must fall back to the default`);
	}
	assert.equal(parseAgentsConfig({ stall_timeout_ms: 45 * 60_000, tool_stall_timeout_ms: 1_000 }, undefined).toolStallTimeoutMs, 45 * 60_000, "the tool ceiling must never fall below the idle budget");
});

test("resolveAgentProfile prefers the profile, then the definition, then the defaults", () => {
	const config = parseAgentsConfig({ default_model: "openai-codex/gpt-6-astra", default_effort: "medium", model_profiles: { "gentle-ai-explore": { effort: "high" } } }, undefined);
	const explore = parseAgentDefinition(EXPLORER, "/x/explore.md", "global");
	assert.ok(!("error" in explore));
	assert.deepEqual(resolveAgentProfile(explore, config), { model: { provider: "openai-codex", id: "gpt-5.6-terra" }, thinking: "high", source: { model: "definition", thinking: "profile" } });
	const bare = parseAgentDefinition("---\nname: bare\n---\nbody", "/x/bare.md", "global");
	assert.ok(!("error" in bare));
	assert.deepEqual(resolveAgentProfile(bare, config), { model: { provider: "openai-codex", id: "gpt-6-astra" }, thinking: "medium", source: { model: "default", thinking: "default" } });
	assert.deepEqual(resolveAgentProfile(bare, parseAgentsConfig(undefined, undefined)).source, { model: "unresolved", thinking: "unresolved" });
});
