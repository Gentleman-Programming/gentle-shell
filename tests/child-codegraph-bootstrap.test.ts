import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { createChildContextExtension } from "../extensions/child-context.ts";
import { REQUESTED_TOOLS_ENV } from "../lib/agents-runner.ts";

const requested = "read,grep,find,codegraph,subagent_parent_message";

function fixture(env: NodeJS.ProcessEnv, existing?: object) {
	const tools = new Map<string, object>();
	if (existing) tools.set("codegraph", existing);
	const hooks = new Map<string, () => unknown>();
	createChildContextExtension(env)({
		on(name: string, handler: () => unknown) { hooks.set(name, handler); },
		getAllTools() { return [...tools.keys()].map(name => ({ name })); },
		registerTool(tool: { name: string }) { assert.equal(tools.has(tool.name), false); tools.set(tool.name, tool); },
	} as unknown as ExtensionAPI);
	return { tools, start: () => hooks.get("session_start")?.() };
}

test("fallback child context supplies explicitly requested CodeGraph without extra tools", () => {
	const f = fixture({ GENTLE_PI_AGENTS_CHILD: "1", [REQUESTED_TOOLS_ENV]: requested });
	f.start();
	assert.deepEqual([...f.tools.keys()], ["codegraph"]);
	const tool = f.tools.get("codegraph") as { parameters: { additionalProperties: boolean; properties: object } };
	assert.equal(tool.parameters.additionalProperties, false);
	assert.deepEqual(Object.keys(tool.parameters.properties), ["operation", "query", "limit"]);
	f.start();
	assert.equal(f.tools.size, 1, "repeated startup cannot register twice");
});

test("fallback never overwrites package CodeGraph or grants it without explicit child scope", () => {
	const existing = { identity: "package-owned implementation" };
	const full = fixture({ GENTLE_PI_AGENTS_CHILD: "1", [REQUESTED_TOOLS_ENV]: requested }, existing);
	full.start();
	assert.equal(full.tools.get("codegraph"), existing);
	for (const env of [{ [REQUESTED_TOOLS_ENV]: requested }, { GENTLE_PI_AGENTS_CHILD: "1" }, { GENTLE_PI_AGENTS_CHILD: "1", [REQUESTED_TOOLS_ENV]: "read,grep,find" }]) {
		const f = fixture(env); f.start(); assert.equal(f.tools.size, 0);
	}
});

test("actual SDK child first model request includes CodeGraph and keeps selected model", async () => {
	const root = mkdtempSync(join(tmpdir(), "child-codegraph-sdk-"));
	const agentDir = join(root, "agent"); mkdirSync(agentDir);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "offline-auth.json"), modelsPath: null, refreshOnCreate: false });
	const observed: { model: string; tools: string[] }[] = [];
	runtime.registerProvider("offline-explore", {
		api: "offline-explore-test", apiKey: "offline-dummy", baseUrl: "http://offline.invalid",
		models: [{ id: "configured-small", name: "Configured small fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple(model, context) {
			observed.push({ model: model.id, tools: getCurrentTools(context.messages).map(tool => tool.name).sort() });
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: "text", text: "Offline child" }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(); });
			return stream;
		},
	});
	const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [createChildContextExtension({ GENTLE_PI_AGENTS_CHILD: "1", [REQUESTED_TOOLS_ENV]: requested })] });
	await loader.reload();
	const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: runtime.getModel("offline-explore", "configured-small")!, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(), tools: ["read", "grep", "find", "codegraph"] });
	try {
		await session.bindExtensions({ mode: "json" });
		await session.prompt("Map local source without modifying files.");
		assert.deepEqual(observed, [{ model: "configured-small", tools: ["codegraph", "find", "grep", "read"] }]);
		assert.deepEqual(session.getActiveToolNames().sort(), ["codegraph", "find", "grep", "read"]);
	} finally { session.dispose(); rmSync(root, { recursive: true, force: true }); }
});
