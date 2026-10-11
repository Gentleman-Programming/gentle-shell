import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { childArguments, type TaskRequest } from "../lib/agents-runner.ts";
import { createAgentSession, DefaultPackageManager, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";

const webTools = ["web_enable", "web_search", "source_check", "fetch_content", "get_search_content"];

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "child-web-package-"));
	const agentDir = join(root, "agent");
	const packageRoot = join(agentDir, "npm", "node_modules", "pi-web-access");
	mkdirSync(join(packageRoot, "dist"), { recursive: true });
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-web-access", type: "module", pi: { extensions: ["./dist"] } }));
	writeFileSync(join(packageRoot, "dist", "index.js"), "export default function(api) {}\n");
	const request: TaskRequest = {
		agent: {
			name: "gentle-ai-explore", description: "Public fixture", filePath: join(root, "explorer.md"), scope: "global",
			tools: ["read", "grep", "find", "codegraph", ...webTools], instructions: "Explore without modifying source.",
			model: undefined, thinking: undefined, mode: undefined,
		},
		prompt: "Explore the public fixture", label: undefined, context: undefined, mode: "task",
		parentSessionId: "fixture-parent", resumeSessionPath: undefined,
		cwd: root, sessionDir: join(root, "sessions"), noExtensions: true,
		extensionPaths: [join(root, "child-context.ts"), join(root, "child-safety.ts"), join(root, "nan-provider.ts")],
		env: { PI_CODING_AGENT_DIR: agentDir }, model: { provider: "fixture", id: "configured-small" }, thinking: "low",
	};
	for (const path of request.extensionPaths!) writeFileSync(path, "export default function(api) {}\n");
	return { root, packageRoot, request };
}

function paths(args: string[]): string[] {
	return args.flatMap((arg, index) => arg === "-e" || arg === "--extension" ? [args[index + 1]] : []);
}

test("requested direct web loads only the installed package alongside the frozen owned bootstrap", () => {
	const f = fixture();
	try {
		f.request.env.HOME = f.request.env.USERPROFILE = join(f.root, "other-home");
		const args = childArguments(f.request);
		assert.deepEqual(paths(args), [...f.request.extensionPaths!, f.packageRoot]);
		assert.ok(args.includes("--no-extensions"), "do not enable ambient plugins to obtain web access");
		assert.equal(args[args.indexOf("--model") + 1], "fixture/configured-small:low");
		assert.equal(args[args.indexOf("--tools") + 1], [...f.request.agent.tools, "subagent_parent_message"].join(","));
	} finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("partial or absent web scope never loads a package or broadens the requested tools", () => {
	const f = fixture();
	try {
		for (const tools of [["read", "grep", "find"], ["web_enable"], ["fetch_content"], webTools.slice(1)]) {
			const request = { ...f.request, agent: { ...f.request.agent, tools } };
			assert.deepEqual(paths(childArguments(request)), request.extensionPaths);
		}
	} finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("already injected web package is not added twice", () => {
	const f = fixture();
	try {
		const request = { ...f.request, extensionPaths: [...f.request.extensionPaths!, f.packageRoot] };
		assert.deepEqual(paths(childArguments(request)), request.extensionPaths);
	} finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a symlink to the injected web package is not loaded again", () => {
	const f = fixture();
	try {
		const alias = join(f.root, "web-alias");
		symlinkSync(f.packageRoot, alias, "junction");
		for (const path of [alias, "web-alias"]) {
			const request = { ...f.request, extensionPaths: [...f.request.extensionPaths!, path] };
			assert.deepEqual(paths(childArguments(request)), request.extensionPaths);
		}
	} finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("web lookup uses the child's home instead of the parent agent directory", () => {
	const f = fixture();
	const parentAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(f.root, "parent-agent");
		const home = join(f.root, "child-home");
		const packageRoot = join(home, ".pi", "agent", "npm", "node_modules", "pi-web-access");
		mkdirSync(packageRoot, { recursive: true });
		const homeEnv = process.platform === "win32" ? { USERPROFILE: home } : { HOME: home };
		for (const override of [undefined, "", "~/.pi/agent"]) {
			const request = { ...f.request, env: { ...homeEnv, PI_CODING_AGENT_DIR: override } };
			assert.deepEqual(paths(childArguments(request)), [...f.request.extensionPaths!, packageRoot]);
		}
	} finally {
		if (parentAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = parentAgentDir;
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("missing or incompatible SDK package lookup never installs or enables ambient extensions", () => {
	const f = fixture();
	const original = DefaultPackageManager.prototype.getInstalledPath;
	try {
		for (const lookup of [() => undefined, () => { throw new Error("unsupported package lookup"); }]) {
			DefaultPackageManager.prototype.getInstalledPath = lookup;
			const args = childArguments(f.request);
			assert.deepEqual(paths(args), f.request.extensionPaths);
			assert.ok(args.includes("--no-extensions"));
		}
	} finally {
		DefaultPackageManager.prototype.getInstalledPath = original;
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("explicit capability scope, not agent name, determines optional web loading", () => {
	const f = fixture();
	try {
		for (const name of ["renamed-explorer", "gentle-ai-worker", "gentle-ai-verify"]) {
			const optedIn = { ...f.request, agent: { ...f.request.agent, name } };
			assert.deepEqual(paths(childArguments(optedIn)), [...f.request.extensionPaths!, f.packageRoot]);
			const localOnly = { ...optedIn, agent: { ...optedIn.agent, tools: ["read", "grep", "find"] } };
			assert.deepEqual(paths(childArguments(localOnly)), f.request.extensionPaths);
		}
	} finally { rmSync(f.root, { recursive: true, force: true }); }
});

async function sdkFixture(block: boolean, injectAlias = false) {
	const f = fixture();
	const marker = "controlled public web evidence";
	const counter = `webFixture_${Math.random().toString(36).slice(2)}`;
	const state = globalThis as unknown as Record<string, number>;
	state[counter] = 0;
	const hooks = `${counter}_hooks`;
	state[hooks] = 0;
	if (injectAlias) {
		const alias = join(f.root, "web-alias");
		symlinkSync(f.packageRoot, alias, "junction");
		f.request.extensionPaths!.push(alias);
	}
	writeFileSync(join(f.packageRoot, "dist", "index.js"), `
export default function(api) {
	api.on("session_start", () => { globalThis[${JSON.stringify(hooks)}]++; });
	for (const name of ${JSON.stringify(webTools)}) api.registerTool({
		name, label: name, description: "Controlled web fixture",
		parameters: { type: "object", properties: { url: { type: "string" } }, additionalProperties: false },
		async execute() {
			globalThis[${JSON.stringify(counter)}]++;
			return { content: [{ type: "text", text: ${JSON.stringify(marker)} }] };
		}
	});
}
`);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const runtime = await ModelRuntime.create({ authPath: join(f.root, "offline-auth.json"), modelsPath: null, refreshOnCreate: false });
	const observed: { model: string; tools: string[] }[] = [];
	let turn = 0;
	runtime.registerProvider("offline-web", {
		api: "offline-web-test", apiKey: "offline-dummy", baseUrl: "http://offline.invalid",
		models: [{ id: "configured-small", name: "Configured small fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple(model, context) {
			observed.push({ model: model.id, tools: getCurrentTools(context.messages).map(tool => tool.name).sort() });
			const calling = turn++ === 0;
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
				content: calling ? [{ type: "toolCall", id: "fixture-fetch", name: "fetch_content", arguments: { url: "https://public.fixture/evidence" } }] : [{ type: "text", text: "Finished" }],
				stopReason: calling ? "toolUse" : "stop",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); stream.end(); });
			return stream;
		},
	});
	const calls: string[] = [];
	const loader = new DefaultResourceLoader({
		cwd: f.root, agentDir: join(f.root, "agent"), settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: paths(childArguments(f.request)),
		extensionFactories: [api => {
			api.on("session_start", () => { api.setActiveTools(webTools); });
			api.on("tool_call", event => {
				calls.push(event.toolName);
				if (block) return { block: true, reason: "fixture permission denied" };
			});
		}],
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({ cwd: f.root, agentDir: join(f.root, "agent"), modelRuntime: runtime, model: runtime.getModel("offline-web", "configured-small")!, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(), tools: webTools }));
		await session.bindExtensions({ mode: "json" });
		assert.equal(state[hooks], 1, "the package's session hook must register only once");
		await session.prompt("Retrieve the controlled public source directly.");
		assert.deepEqual(calls, ["fetch_content"], JSON.stringify({ observed, messages: session.messages.map(message => ({ role: message.role, errorMessage: message.role === "assistant" ? message.errorMessage : undefined, content: message.role === "toolResult" ? message.content : undefined })) }));
		assert.ok(observed.length >= 2);
		assert.ok(observed.every(request => request.model === "configured-small"));
		assert.ok(observed[0].tools.includes("fetch_content"), "registration must reach an actual SDK model request");
		assert.equal(state[counter], block ? 0 : 1, "permission interception occurs before backend execution");
		const result = session.messages.find(message => message.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		assert.equal(Boolean(result.isError), block);
		assert.ok(JSON.stringify(result.content).includes(block ? "fixture permission denied" : marker));
	} finally {
		session?.dispose();
		delete state[counter];
		delete state[hooks];
		rmSync(f.root, { recursive: true, force: true });
	}
}

test("production child paths register and execute web through actual SDK hooks without network", async () => {
	await sdkFixture(false);
});

test("a symlink-injected web package registers actual SDK hooks once", async () => {
	await sdkFixture(false, true);
});

test("normal SDK permission hook blocks web execution before the backend", async () => {
	await sdkFixture(true);
});
