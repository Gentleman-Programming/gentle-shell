import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage, JsonObject, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Rarely used and state-bound tools leave the primary request's declarations
// only while codemode, a route the prompt names, still reaches them; without
// codemode they stay direct declarations. Real Pi SDK sessions, offline
// provider: each request's declared tools and system prompt are recorded.

interface RecordedRequest { systemPrompt: string; tools: string[]; toolResults: Array<{ name: string; isError: boolean; text: string }> }
interface Step { prompt: string; call?: { name: string; arguments: JsonObject }; before?: () => void }

const DESIGN_TOOLS = ["gentle_design", "gentle_design_comments"];

async function runSession(root: string, label: string, options: { codemode: boolean; design?: boolean; env?: NodeJS.ProcessEnv; steps: Step[] }): Promise<{ requests: RecordedRequest[]; errors: string[]; cwd: string }> {
	const sdk = await import("@earendil-works/pi-coding-agent");
	const ai = await import("@earendil-works/pi-ai");
	const { default: gentleDesign } = await import("../extensions/gentle-design.ts");
	const { default: gentleGuide } = await import("../extensions/gentle-guide.ts");
	const { registerCompactCodemode } = await import("../lib/codemode-renderer.ts");
	const cwd = join(root, `repo-${label}`);
	mkdirSync(cwd);
	if (options.design) mkdirSync(join(cwd, "design"));
	const requests: RecordedRequest[] = [];
	const errors: string[] = [];
	const queue: Array<{ name: string; arguments: JsonObject } | undefined> = [];
	let calls = 0;
	const model = { id: "driver", name: "Local driver", provider: "hidden-fixture", api: "hidden-fixture", baseUrl: "http://invalid.local", reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;
	const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", packages: [] });
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, `models-${label}.json`), refreshOnCreate: false, allowModelNetwork: false });
	const loader = new sdk.DefaultResourceLoader({
		cwd, agentDir: join(root, "profile"), settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi: ExtensionAPI) => {
			gentleDesign(pi, { env: options.env ?? {} });
			gentleGuide(pi, options.env ?? {});
			registerCompactCodemode(pi);
			pi.registerProvider("hidden-fixture", {
				api: "hidden-fixture", apiKey: "fixture-only", baseUrl: "http://invalid.local",
				models: [{ id: model.id, name: model.name, reasoning: false, input: ["text"], cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
				streamSimple(_model, context) {
					requests.push({
						systemPrompt: ai.getCurrentSystemPrompt(context.messages) ?? "",
						tools: (ai.getCurrentTools(context.messages) ?? []).map((tool) => tool.name),
						toolResults: context.messages.flatMap((message) => message.role === "toolResult"
							? [{ name: message.toolName, isError: message.isError, text: message.content.map((part) => part.type === "text" ? part.text : "").join("") }] : []),
					});
					const request = queue.shift();
					calls += 1;
					const stream = ai.createAssistantMessageEventStream();
					const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "pending" as never, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
					queueMicrotask(() => {
						stream.push({ type: "start", partial: message });
						if (request) {
							const toolCall: ToolCall = { type: "toolCall", id: `call-${calls}`, ...request };
							message.content.push(toolCall);
							stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
							stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
						}
						message.stopReason = request ? "toolUse" : "stop";
						stream.push({ type: "done", reason: message.stopReason, message });
						stream.end();
					});
					return stream;
				},
			});
		}],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({
		cwd, agentDir: join(root, "profile"), modelRuntime: runtime, model: model as never, thinkingLevel: "off", resourceLoader: loader,
		tools: ["read", ...DESIGN_TOOLS, "gentle_guide", ...(options.codemode ? ["codemode"] : [])],
		sessionManager: sdk.SessionManager.inMemory(cwd), settingsManager: settings,
	});
	try {
		await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error.error) });
		for (const step of options.steps) {
			step.before?.();
			queue.push(step.call, undefined);
			await session.prompt(step.prompt, { source: "interactive" });
		}
	} finally {
		await session.abort();
		session.dispose();
	}
	return { requests, errors, cwd };
}

function fixture(t: { after: (fn: () => void) => void }): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-hidden-tools-")));
	mkdirSync(join(root, "profile"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

const codemodeCall = (code: string) => ({ name: "codemode", arguments: { code } });
const DESIGN_ROUTE = /gentle_design and gentle_design_comments are not declared in this run: call them from codemode, such as `tools\.gentle_design\(\{ action: "list" \}\)`\./;
const GUIDE_ROUTE = /gentle_guide is not declared: call it from codemode/;

test("with codemode and no design/ the design and guide tools leave the request, stay callable from codemode, and the list is stable", { timeout: 60_000 }, async (t) => {
	const root = fixture(t);
	const run = await runSession(root, "hidden", { codemode: true, steps: [
		{ prompt: "Start the tour.", call: codemodeCall('return await tools.gentle_guide({ action: "start" });') },
		{ prompt: "List the designs.", call: codemodeCall('return await tools.gentle_design({ action: "list" });') },
	] });
	assert.deepEqual(run.errors, []);
	assert.equal(run.requests.length, 4, "a tool turn and a reply turn per prompt");
	for (const request of run.requests) {
		assert.deepEqual(request.tools, ["read", "codemode"], "only the reachable declarations are sent");
		assert.match(request.systemPrompt, DESIGN_ROUTE);
		assert.match(request.systemPrompt, GUIDE_ROUTE);
		assert.doesNotMatch(request.systemPrompt, /- gentle_guide: /, "a hidden tool's snippet leaves the tool list too");
	}
	assert.equal(new Set(run.requests.map((request) => JSON.stringify(request.tools))).size, 1, "consecutive requests carry the same tool list");
	assert.equal(new Set(run.requests.map((request) => request.systemPrompt)).size, 1, "and the same system prompt");
	const [guide, design] = [run.requests[1].toolResults.at(-1)!, run.requests[3].toolResults.at(-1)!];
	assert.equal(guide.name, "codemode");
	assert.equal(guide.isError, false);
	assert.match(guide.text, /Script completed[\s\S]*Tour steps: /, "the hidden guide tool ran from codemode");
	assert.equal(design.isError, false);
	assert.match(design.text, /Script completed[\s\S]*design/i, "the hidden design tool ran from codemode");
	assert.doesNotMatch(design.text, /not a function|is not defined|unknown tool/i);
});

test("without codemode every tool stays a direct declaration and no route is named", { timeout: 60_000 }, async (t) => {
	const root = fixture(t);
	const run = await runSession(root, "direct", { codemode: false, steps: [{ prompt: "hello" }, { prompt: "again" }] });
	assert.deepEqual(run.errors, []);
	for (const request of run.requests) {
		assert.deepEqual([...request.tools].sort(), ["gentle_design", "gentle_design_comments", "gentle_guide", "read"]);
		assert.doesNotMatch(request.systemPrompt, DESIGN_ROUTE);
		assert.doesNotMatch(request.systemPrompt, GUIDE_ROUTE);
	}
});

test("with a design/ directory the design tools are declared; one appearing mid-session declares them from the next run", { timeout: 60_000 }, async (t) => {
	const root = fixture(t);
	const present = await runSession(root, "present", { codemode: true, design: true, steps: [{ prompt: "hello" }] });
	assert.deepEqual(present.errors, []);
	assert.deepEqual([...present.requests[0].tools].sort(), ["codemode", "gentle_design", "gentle_design_comments", "read"]);
	assert.doesNotMatch(present.requests[0].systemPrompt, DESIGN_ROUTE);
	assert.match(present.requests[0].systemPrompt, GUIDE_ROUTE, "the guide stays behind codemode");

	const appearing = await runSession(root, "appearing", { codemode: true, steps: [
		{ prompt: "first" },
		{ prompt: "second" },
		{ prompt: "third", before: () => mkdirSync(join(root, "repo-appearing", "design")) },
	] });
	assert.deepEqual(appearing.errors, []);
	const [first, second, third] = appearing.requests;
	assert.deepEqual(first.tools, ["read", "codemode"]);
	assert.deepEqual(second.tools, first.tools, "unchanged state keeps the list");
	assert.deepEqual([...third.tools].sort(), ["codemode", "gentle_design", "gentle_design_comments", "read"], "the next run after design/ appears declares them");
	assert.doesNotMatch(third.systemPrompt, DESIGN_ROUTE);
});

test("delegated children keep the design tools declared", { timeout: 60_000 }, async (t) => {
	const root = fixture(t);
	const run = await runSession(root, "child", { codemode: true, env: { GENTLE_PI_AGENTS_CHILD: "1" }, steps: [{ prompt: "hello" }] });
	assert.deepEqual(run.errors, []);
	assert.deepEqual([...run.requests[0].tools].sort(), ["codemode", "gentle_design", "gentle_design_comments", "read"]);
	assert.doesNotMatch(run.requests[0].systemPrompt, DESIGN_ROUTE);
});

// Verifier probe (mwb9y35y-23-1w1c): a model that calls a hidden tool by its
// own name still reaches it, because the tool stays active.
test("a hidden tool called directly by name still runs", { timeout: 60_000 }, async (t) => {
	const root = fixture(t);
	const run = await runSession(root, "direct-call", { codemode: true, steps: [
		{ prompt: "Start the tour.", call: { name: "gentle_guide", arguments: { action: "start" } } },
		{ prompt: "List the designs.", call: { name: "gentle_design", arguments: { action: "list" } } },
	] });
	assert.deepEqual(run.errors, []);
	assert.deepEqual(run.requests[0].tools, ["read", "codemode"], "both tools are hidden while the call is made");
	assert.deepEqual(run.requests[2].tools, ["read", "codemode"]);
	const [guide, design] = [run.requests[1].toolResults.at(-1)!, run.requests[3].toolResults.at(-1)!];
	assert.equal(guide.name, "gentle_guide");
	assert.equal(guide.isError, false);
	assert.match(guide.text, /Tour steps: /);
	assert.equal(design.name, "gentle_design");
	assert.equal(design.isError, false);
	assert.match(design.text, /No designs in design\/ yet/);
});
