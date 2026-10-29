import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
import gentleAgents, { type SessionTransportFactory } from "../extensions/gentle-agents.ts";
import { fakeChild, type FakeChild } from "./agents-fake-child.ts";

const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { UserMessageComponent } = await import(new URL("./modes/interactive/components/user-message.js", sdk).href);
const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", sdk).href);
initTheme("dark");
const transport: SessionTransportFactory = {
	createRegistry: async () => ({ list: async () => [], listActivations: async () => [] }),
	createListener: registry => ({ registry, start: async () => {}, close: async () => {} }),
	createClient: () => ({ close() {}, sendNotification: async () => { throw new Error("Offline fixture forbids transport"); } }),
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!predicate() && Date.now() < deadline) await tick();
	assert.ok(predicate(), "offline lifecycle did not settle");
}

test("actual SDK Bridge wake retains preparation, history, reload and resumed rendering offline", async () => {
	const root = mkdtempSync(join(tmpdir(), "bridge-lifecycle-"));
	const home = join(root, "home"), cwd = join(root, "project"), agentDir = join(root, "agent");
	mkdirSync(home, { recursive: true });
	mkdirSync(cwd); mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(join(agentDir, "agents", "explore.md"), "---\ndescription: Offline fixture\n---\nReturn a fixture answer.");
	const children: FakeChild[] = [], requests: TranscriptContext[] = [];
	let preparations = 0;
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "offline-auth.json"), modelsPath: null, refreshOnCreate: false });
	// The provider name tests routing, but this model has no live implementation.
	modelRuntime.registerProvider("claude-bridge", {
		api: "bridge-offline-test", apiKey: "explicit-offline-dummy", baseUrl: "http://offline.invalid",
		models: [{ id: "offline-recording", name: "Offline recording", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple: (model, context) => {
			assert.equal(model.id, "offline-recording");
			requests.push(structuredClone(context));
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: "text", text: "Offline continued" }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(); });
			return stream;
		},
	});
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [pi => {
			gentleAgents(pi, {}, { home, agentHome: agentDir, env: { PATH: "/usr/bin:/bin" }, pi: { command: "offline-child", args: [] }, spawn: () => { const child = fakeChild(); children.push(child); return child.child; }, schedule: () => () => {}, sessionTransport: transport, resolveWorktree: () => undefined });
			pi.registerTool({ name: "sentinel", label: "Sentinel", description: "Offline sentinel tool", parameters: { type: "object", properties: {} } as never, execute: async () => ({ content: [], details: undefined }) });
			pi.on("before_agent_start", event => {
				preparations++;
				pi.setActiveTools(["sentinel"]);
				event.systemPromptOptions.appendSystemPrompt += `\nBRIDGE_PREPARATION_SENTINEL_${preparations}`;
				event.systemPromptOptions.selectedTools = ["sentinel"];
			});
		}],
	});
	await loader.reload();
	const manager = SessionManager.create(cwd, join(root, "sessions"));
	const model = modelRuntime.getModel("claude-bridge", "offline-recording")!;
	const errors: string[] = [];
	const create = async (sessionManager: SessionManager) => {
		const result = await createAgentSession({ cwd, agentDir, modelRuntime, model, tools: ["sentinel"], settingsManager, resourceLoader: loader, sessionManager });
		await result.session.bindExtensions({ mode: "rpc", onError: error => errors.push(error.error) });
		return result.session;
	};
	let session = await create(manager);
	try {
		await session.prompt("Ordinary human turn");
		const launch = async (id: string) => {
			const tool = session.extensionRunner.getAllRegisteredTools().find(tool => tool.definition.name === "subagent_run")!.definition;
			const count = children.length;
			const result = await tool.execute(id, { agent: "explore", task: "Offline work", mode: "background" }, undefined, undefined, session.extensionRunner.createToolContext(id, undefined));
			assert.ok(JSON.stringify(result).includes("taskId"), JSON.stringify(result));
			await until(() => children.length > count);
			return children.at(-1)!;
		};
		const child = await launch("completion");
		child.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "OFFLINE_CHILD_RESULT" }] }] });
		child.emit({ type: "agent_settled" });
		await until(() => requests.length === 2 && session.isIdle);
		assert.equal(preparations, 2, "wake traverses normal prompt/before_agent_start");
		assert.match(getCurrentSystemPrompt(requests[1].messages), /BRIDGE_PREPARATION_SENTINEL_2/);
		assert.deepEqual(getCurrentTools(requests[1].messages).map(tool => tool.name), ["sentinel"]);
		const wakeEntries = manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "gentle-agents.wake-identity");
		assert.equal(wakeEntries.length, 1);
		const identity = (wakeEntries[0] as { data: { text: string } }).data;
		assert.ok(session.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(identity.text)), "wake is still user-role history");
		assert.ok(JSON.stringify(requests[1].messages).includes(identity.text), "wake remains model-visible");
		assert.equal(manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "gentle-agents.result").length, 1);
		const render = (text: string) => new UserMessageComponent(text, undefined, 1, session.extensionRunner.getMarkdownTransformers()).render(80);
		assert.deepEqual(render(identity.text), []);
		assert.ok(render("Ordinary human turn").length > 0);
		await session.reload();
		assert.equal(session.extensionRunner.getMarkdownTransformers().length, 1);
		assert.deepEqual(render(identity.text), [], "reload reconstructs the durable identity");
		const file = manager.getSessionFile()!;
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		await loader.reload();
		session = await create(SessionManager.open(file));
		assert.equal(session.extensionRunner.getMarkdownTransformers().length, 1);
		assert.deepEqual(render(identity.text), [], "opening saved history restores suppression");
		const queryChild = await launch("query");
		queryChild.message({ id: "q1", kind: "query", message: "OFFLINE_CHILD_QUERY" });
		await until(() => requests.length === 3 && session.isIdle);
		assert.equal(preparations, 3);
		assert.match(getCurrentSystemPrompt(requests[2].messages), /BRIDGE_PREPARATION_SENTINEL_3/);
		assert.deepEqual(getCurrentTools(requests[2].messages).map(tool => tool.name), ["sentinel"]);
		assert.equal(session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "gentle-agents.wake-identity").length, 1, "resume reuses one identity");
		assert.equal(session.sessionManager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "gentle-agents.message").length, 1, "query stored once");
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		await loader.reload();
		session = await create(SessionManager.inMemory(cwd));
		assert.equal(session.extensionRunner.getMarkdownTransformers().length, 1);
		assert.ok(render(identity.text).length > 0, "switching to another session releases the old identity");
		assert.ok(render("Ordinary human turn").length > 0);
		assert.deepEqual(errors, []);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
