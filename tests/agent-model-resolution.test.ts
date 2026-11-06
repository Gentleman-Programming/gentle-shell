import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { resolveAgentHomeDirectory, resolveEffectiveAgentModel, resolvePinnedAgentProfile } from "../lib/agent-model-resolution.ts";
import type { AgentDefinition } from "../lib/agents-config.ts";

// gentle-shell#1731 S3/AC3: the subagent launch and the harness model-routing
// fact resolve the effective subagent model through one helper, so the fact
// can never disagree with the model a launch would actually use.

const root = mkdtempSync(join(tmpdir(), "gentle-pi-agent-model-resolution-"));
after(() => rmSync(root, { recursive: true, force: true }));

function fixture(name: string) {
	const base = join(root, name);
	const home = join(base, "home");
	const agentHome = join(base, "agent-home");
	const cwd = join(base, "project");
	const commonDir = join(base, "git-common");
	const configHome = join(base, "config");
	for (const dir of [home, join(agentHome, "agents"), cwd, commonDir, configHome]) mkdirSync(dir, { recursive: true });
	return {
		roots: { cwd, home, agentHome },
		cwd,
		configHome,
		resolveWorktree: () => ({ root: cwd, commonDir }),
		writeAgent(agentName: string, model?: string) {
			writeFileSync(join(agentHome, "agents", `${agentName}.md`), `---\nname: ${agentName}\ndescription: Test agent.\n${model === undefined ? "" : `model: ${model}\n`}---\nBody.\n`);
		},
		writeSubagents(config: Record<string, unknown>) {
			writeFileSync(join(agentHome, "subagents.json"), JSON.stringify(config));
		},
		writePinnedProfile(profiles: Record<string, unknown>, pin: string) {
			writeFileSync(join(configHome, "profiles.json"), JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, profiles }));
			mkdirSync(join(commonDir, "gentle-ai"), { recursive: true });
			writeFileSync(join(commonDir, "gentle-ai", "profile-pin.json"), JSON.stringify({ kind: "gentle-pi.agent_model_profile_pin", version: 1, profile: pin }));
		},
	};
}

const orchestrator = { provider: "anthropic", id: "fable" };

test("the effective worker model comes from the global subagent profile", () => {
	const f = fixture("global-profile");
	f.writeAgent("gentle-ai-worker");
	f.writeSubagents({ model_profiles: { "gentle-ai-worker": { model: "anthropic/opus" } } });
	assert.deepEqual(
		resolveEffectiveAgentModel("gentle-ai-worker", { roots: f.roots, pinCwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree, fallback: orchestrator }),
		{ agent: "gentle-ai-worker", model: { provider: "anthropic", id: "opus" }, inherited: false },
	);
});

test("a repository profile pin replaces global routing for the effective worker model", () => {
	const f = fixture("pinned-profile");
	f.writeAgent("gentle-ai-worker");
	f.writeSubagents({ model_profiles: { "gentle-ai-worker": { model: "anthropic/opus" } } });
	f.writePinnedProfile({ cheap: { "gentle-ai-worker": { model: "openai/mini" } } }, "cheap");
	assert.deepEqual(
		resolveEffectiveAgentModel("gentle-ai-worker", { roots: f.roots, pinCwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree, fallback: orchestrator })?.model,
		{ provider: "openai", id: "mini" },
	);
});

test("the agent definition model applies when no profile routes the agent", () => {
	const f = fixture("definition-model");
	f.writeAgent("gentle-ai-worker", "openai/defined");
	assert.deepEqual(
		resolveEffectiveAgentModel("gentle-ai-worker", { roots: f.roots, pinCwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree, fallback: orchestrator })?.model,
		{ provider: "openai", id: "defined" },
	);
});

test("an unrouted agent inherits the fallback session model", () => {
	const f = fixture("inherit");
	f.writeAgent("gentle-ai-worker");
	assert.deepEqual(
		resolveEffectiveAgentModel("gentle-ai-worker", { roots: f.roots, pinCwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree, fallback: orchestrator }),
		{ agent: "gentle-ai-worker", model: orchestrator, inherited: true },
	);
	assert.deepEqual(
		resolveEffectiveAgentModel("gentle-ai-worker", { roots: f.roots, pinCwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree }),
		{ agent: "gentle-ai-worker", model: undefined, inherited: true },
	);
});

test("an undiscovered agent resolves to undefined", () => {
	const f = fixture("missing-agent");
	assert.equal(
		resolveEffectiveAgentModel("gentle-ai-worker", { roots: f.roots, pinCwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree, fallback: orchestrator }),
		undefined,
	);
});

test("resolvePinnedAgentProfile returns the launch profile with its model and thinking", () => {
	const f = fixture("launch-profile");
	f.writePinnedProfile({ deep: { explore: { model: "openai/alpha", thinking: "minimal" } } }, "deep");
	const agent: AgentDefinition = { name: "explore", description: "", filePath: "", scope: "global", instructions: "", model: undefined, thinking: undefined, mode: undefined, tools: [] };
	const profile = resolvePinnedAgentProfile(agent, { roots: f.roots, pinCwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree });
	assert.deepEqual(profile.model, { provider: "openai", id: "alpha" });
	assert.equal(profile.thinking, "minimal");
	assert.equal(profile.source.model, "profile");
});

test("resolveAgentHomeDirectory follows the environment, expands tildes, and keeps explicit overrides literal", () => {
	const home = "/home/tester";
	assert.equal(resolveAgentHomeDirectory({ env: { GENTLE_PI_AGENT_HOME: "/opt/agents" }, home }), resolve("/opt/agents"));
	assert.equal(resolveAgentHomeDirectory({ env: { PI_CODING_AGENT_DIR: "~/pi-agent" }, home }), resolve(join(home, "pi-agent")));
	assert.equal(resolveAgentHomeDirectory({ env: { GENTLE_PI_AGENT_HOME: "~" }, home }), resolve(home));
	assert.equal(resolveAgentHomeDirectory({ env: { GENTLE_PI_AGENT_HOME: "/ignored" }, home, homeOverridden: true }), resolve(join(home, ".pi", "agent")));
	assert.equal(resolveAgentHomeDirectory({ env: {}, home, agentHome: "/explicit" }), resolve("/explicit"));
});
