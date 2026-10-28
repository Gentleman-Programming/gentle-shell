import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension, __testing } from "../extensions/gentle-ai.ts";

// gentle-shell#1731 T24 (L49): the cost reason is off, so the harness no
// longer injects the orchestrator/worker "Model routing" price ratio, even
// when configured routing makes the orchestrator 3x the worker.
// lib/model-price-ratio.ts stays (tests/model-price-ratio.test.ts) so a later
// phase can re-enable the fact.

type BeforeAgentStartHandler = (event: unknown, ctx: ExtensionContext) => Promise<undefined>;
type MutableEvent = { agentName?: string; systemPrompt: string; systemPromptOptions: { appendSystemPrompt: string } };

let fixtureRoot: string;
let fixtureCwd: string;
let agentHome: string;
const fixtureEnvironment: NodeJS.ProcessEnv = {};
const previousEnvironment = new Map<string, string | undefined>();
before(() => {
	fixtureRoot = mkdtempSync(join(tmpdir(), "gentle-pi-model-routing-prompt-"));
	fixtureCwd = join(fixtureRoot, "project");
	const home = join(fixtureRoot, "home");
	agentHome = join(home, "agents-home");
	mkdirSync(fixtureCwd);
	mkdirSync(join(agentHome, "agents"), { recursive: true });
	writeFileSync(join(agentHome, "agents", "gentle-ai-worker.md"), "---\nname: gentle-ai-worker\ndescription: Worker.\n---\nBody.\n");
	writeFileSync(join(agentHome, "subagents.json"), JSON.stringify({ model_profiles: { "gentle-ai-worker": { model: "anthropic/opus" } } }));
	Object.assign(fixtureEnvironment, {
		HOME: home, USERPROFILE: home,
		GENTLE_PI_CONFIG_HOME: join(home, "config"),
		GENTLE_PI_AGENT_HOME: agentHome,
		PI_CODING_AGENT_DIR: join(home, "pi"),
		XDG_CONFIG_HOME: join(home, "xdg"),
	});
	for (const [key, value] of Object.entries(fixtureEnvironment)) {
		previousEnvironment.set(key, process.env[key]);
		process.env[key] = value;
	}
});
after(() => {
	for (const [key, value] of previousEnvironment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(fixtureRoot, { recursive: true, force: true });
});

function harness(): BeforeAgentStartHandler {
	const handlers = new Map<string, BeforeAgentStartHandler>();
	const pi = {
		on(name: string, handler: BeforeAgentStartHandler) {
			handlers.set(name, handler);
		},
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: null,
		processEnv: { ...fixtureEnvironment, GENTLE_PI_AGENTS_CHILD: "0", GENTLE_AI_TELEMETRY: "0" },
		resolveTelemetryTriggerBinary: () => join(fixtureCwd, "never-executed"),
		telemetryTriggerSpawn: () => assert.fail("Model routing fixtures must not spawn telemetry"),
	})(pi);
	const beforeAgentStart = handlers.get("before_agent_start");
	assert.equal(typeof beforeAgentStart, "function");
	return beforeAgentStart as BeforeAgentStartHandler;
}

const catalog = [
	{ provider: "anthropic", id: "fable", cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
	{ provider: "anthropic", id: "opus", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
];
const registry = {
	find: (provider: string, id: string) => catalog.find((model) => model.provider === provider && model.id === id),
	getAll: () => catalog,
};

function ctx(overrides: Record<string, unknown> = {}): ExtensionContext {
	return {
		cwd: fixtureCwd,
		hasUI: true,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "model-routing-prompt-session" },
		model: catalog[0],
		modelRegistry: registry,
		...overrides,
	} as unknown as ExtensionContext;
}

function primaryEvent(overrides: Partial<MutableEvent> = {}): MutableEvent {
	return { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" }, ...overrides };
}

test("buildGentlePrompt renders no model routing fact", () => {
	const rddLine = __testing.renderRddStatusLine(undefined);
	assert.doesNotMatch(__testing.buildGentlePrompt("neutral", fixtureCwd, undefined, rddLine), /Model routing:|price ratio/);
	assert.doesNotMatch(__testing.getOrchestratorPrompt(fixtureCwd, undefined, rddLine), /Model routing:/);
});

test("before_agent_start never injects the price ratio for the primary session, even at 3x", async () => {
	const event = primaryEvent();
	await harness()(event, ctx());
	const appended = event.systemPromptOptions.appendSystemPrompt;
	assert.ok(appended.includes("Harness principles:"), appended.slice(0, 200));
	assert.doesNotMatch(appended, /Model routing:|price ratio/);
});

test("before_agent_start never consults the model catalog for a price ratio", async () => {
	const event = primaryEvent();
	const failing = { find: () => assert.fail("no price lookup"), getAll: () => assert.fail("no price lookup") };
	await harness()(event, ctx({ modelRegistry: failing }));
	assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /Model routing:/);
});

test("before_agent_start never injects the fact into a named agent session", async () => {
	const event = primaryEvent({ agentName: "gentle-ai-worker" });
	await harness()(event, ctx());
	assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /Model routing:/);
});
