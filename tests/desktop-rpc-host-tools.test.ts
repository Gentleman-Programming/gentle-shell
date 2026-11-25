import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AssistantMessage, JsonObject, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { DESKTOP_RPC_SCHEMA } from "../lib/desktop-rpc.ts";
import {
	ALREADY_ANSWERED,
	DESKTOP_HOST_TOOLS_EVENTS,
	DESKTOP_HOST_TOOLS_LIMITS,
	DESKTOP_HOST_TOOLS_METHODS,
	HOST_TOOL_RESULT_TOO_LARGE,
	hostToolOfflineText,
	modelGuidelines,
	parseHostToolResult,
	parseSetHostTools,
	UNKNOWN_CALL,
} from "../lib/desktop-rpc-host-tools.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// Host tools: a Desktop client offers tools that run on the client. The agent
// calls them like any tool; the call becomes a `host_tool_call` event and the
// client's `host_tool_result` becomes the tool result. Unit tests drive the real
// extension over a fake Pi tool registry; the last tests run a real Pi SDK
// session with an offline scripted provider (no model) to prove registration,
// guidelines, results and aborts reach Pi the way the model would see them.

const SCHEMA = { type: "object", properties: { region: { type: "string" } }, required: ["region"] };

function spec(name: string, extra: Record<string, unknown> = {}) {
	return { name, label: `Label ${name}`, description: `Does ${name} on the client.\nMore detail.`, parameters: SCHEMA, ...extra };
}

interface FakeTimer { callback: () => void; ms: number }

function setInteractiveHost(t: test.TestContext) {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
}

function harness(t: test.TestContext) {
	setInteractiveHost(t);
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	/** What Pi holds: the last definition registered under each name. */
	const registry = new Map<string, any>();
	const registrations: any[] = [];
	const timers = new Map<number, FakeTimer>();
	let nextTimer = 0;
	let nextCall = 0;
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut() {},
		on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { on() { return () => {}; }, emit() {} },
		registerTool(definition: any) { registry.set(definition.name, definition); registrations.push(definition); },
		getAllTools() {
			return [{ name: "read" }, { name: "bash" }, { name: "gentle_todo" }, ...[...registry.keys()].map((name) => ({ name }))];
		},
	} as unknown as ExtensionAPI;
	desktopRpc(pi, {
		hostTools: {
			timers: {
				setTimeout(callback, ms) { nextTimer += 1; timers.set(nextTimer, { callback, ms }); return nextTimer; },
				clearTimeout(handle) { timers.delete(handle as number); },
			},
			newCallId: () => `call-${(nextCall += 1)}`,
		},
	});
	const widgets: string[] = [];
	const ctx = {
		mode: "rpc",
		cwd: "/x",
		sessionManager: { getCwd: () => "/x", getSessionId: () => "s", getEntries: () => [] },
		ui: { setWidget(_key: string, lines: string[]) { widgets.push(...lines); } },
	};
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	let request = 0;
	const lines = () => widgets.map((line) => JSON.parse(line));
	return {
		registry,
		registrations,
		timers,
		widgets,
		raw(text: string) { return commands.get("gentle:desktop")!.handler(text, ctx); },
		async invoke(method: string, params: Record<string, unknown> = {}) {
			request += 1;
			const requestId = `r-${request}`;
			await commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params }), ctx);
			const response = lines().find((line) => line.kind === "response" && line.requestId === requestId);
			assert.ok(response, `a response to ${method}`);
			return response;
		},
		events(name: string) { return lines().filter((line) => line.kind === "event" && line.event === name).map((line) => line.data); },
		async shutdown() { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx); },
	};
}

// ---- Contract ----

test("the Desktop transport advertises set_host_tools, host_tool_result and both events once", async (t) => {
	assert.deepEqual([...DESKTOP_HOST_TOOLS_METHODS], ["set_host_tools", "host_tool_result"]);
	assert.deepEqual([...DESKTOP_HOST_TOOLS_EVENTS], ["host_tool_call", "host_tool_cancel"]);
	const app = harness(t);
	const caps = await app.invoke("capabilities");
	for (const name of DESKTOP_HOST_TOOLS_METHODS) assert.equal(caps.data.methods.filter((m: string) => m === name).length, 1);
	for (const name of DESKTOP_HOST_TOOLS_EVENTS) assert.equal(caps.data.events.filter((e: string) => e === name).length, 1);
	assert.equal(app.registrations.length, 0, "nothing is registered with Pi until a client asks");
});

test("set_host_tools validates the provider, every tool and the limits", () => {
	const bad = (params: Record<string, unknown>) => {
		const parsed = parseSetHostTools(params);
		assert.equal(parsed.ok, false, JSON.stringify(params).slice(0, 120));
		if (!parsed.ok) assert.equal(parsed.error.code, "invalid_request");
	};
	assert.equal(parseSetHostTools({ provider: "app", tools: [] }).ok, true, "an empty list unregisters");
	bad({ tools: [] });
	bad({ provider: "", tools: [] });
	bad({ provider: "x".repeat(65), tools: [] });
	bad({ provider: "app\n", tools: [] });
	bad({ provider: "app", tools: [], extra: 1 });
	bad({ provider: "app", tools: "nope" });
	bad({ provider: "app", tools: Array.from({ length: 33 }, (_, i) => spec(`t${i}`)) });
	bad({ provider: "app", tools: [spec("Bad-Name")] });
	bad({ provider: "app", tools: [spec("a".repeat(65))] });
	bad({ provider: "app", tools: [spec("dup"), spec("dup")] });
	bad({ provider: "app", tools: [spec("t", { label: "x".repeat(65) })] });
	bad({ provider: "app", tools: [spec("t", { description: "x".repeat(4097) })] });
	bad({ provider: "app", tools: [spec("t", { parameters: { type: "string" } })] });
	bad({ provider: "app", tools: [spec("t", { parameters: [] })] });
	bad({ provider: "app", tools: [spec("t", { parameters: { type: "object", description: "x".repeat(16 * 1024) } })] });
	bad({ provider: "app", tools: [spec("t", { guidelines: Array.from({ length: 17 }, () => "Use t.") })] });
	bad({ provider: "app", tools: [spec("t", { guidelines: ["x".repeat(513)] })] });
	bad({ provider: "app", tools: [spec("t", { guidelines: ["two\nlines"] })] });
	bad({ provider: "app", tools: [spec("t", { run: "rm -rf /" })] });
	const full = parseSetHostTools({ provider: "app", tools: Array.from({ length: 32 }, (_, i) => spec(`t${i}`, { guidelines: Array.from({ length: 16 }, () => "g".repeat(512)) })) });
	assert.equal(full.ok, true, "the limits themselves are allowed");
});

test("host_tool_result validates content and caps it at 8 MiB of text bytes and base64", () => {
	assert.deepEqual(parseHostToolResult({ callId: "c", content: [{ type: "text", text: "hi" }] }), { ok: true, value: { callId: "c", content: [{ type: "text", text: "hi" }], isError: false } });
	for (const params of [
		{ content: [{ type: "text", text: "x" }] },
		{ callId: "", content: [{ type: "text", text: "x" }] },
		{ callId: "c", content: [] },
		{ callId: "c", content: [{ type: "video", data: "AAAA" }] },
		{ callId: "c", content: [{ type: "image", data: "not base64!", mimeType: "image/png" }] },
		{ callId: "c", content: [{ type: "image", data: "AAAA", mimeType: "text/html" }] },
		{ callId: "c", content: [{ type: "text", text: "x" }], isError: "yes" },
		{ callId: "c", content: [{ type: "text", text: "x" }], extra: true },
	]) assert.equal(parseHostToolResult(params as Record<string, unknown>).ok, false, JSON.stringify(params));
	const limit = DESKTOP_HOST_TOOLS_LIMITS.contentBytes;
	const image = "A".repeat(limit - 4);
	assert.equal(parseHostToolResult({ callId: "c", content: [{ type: "image", data: image, mimeType: "image/png" }, { type: "text", text: "four" }] }).ok, true);
	assert.deepEqual(parseHostToolResult({ callId: "c", content: [{ type: "image", data: image, mimeType: "image/png" }, { type: "text", text: "fives" }] }), { ok: false, error: HOST_TOOL_RESULT_TOO_LARGE });
});

// ---- Registration ----

test("set_host_tools registers each tool with Pi as a direct tool with its schema, snippet and guidelines", async (t) => {
	const app = harness(t);
	const response = await app.invoke("set_host_tools", { provider: "gentle-desktop", tools: [
		spec("desktop_screenshot", { guidelines: ["Use desktop_screenshot to see what the user sees.", "Ask before capturing private windows."] }),
		spec("desktop_open_url"),
	] });
	assert.deepEqual(response.data, { registered: ["desktop_screenshot", "desktop_open_url"], rejected: [] });
	const shot = app.registry.get("desktop_screenshot");
	assert.equal(shot.exposure, "direct");
	assert.equal(shot.label, "Label desktop_screenshot");
	assert.equal(shot.description, "Does desktop_screenshot on the client.\nMore detail.");
	assert.deepEqual(shot.parameters, SCHEMA);
	assert.equal(shot.promptSnippet, "Does desktop_screenshot on the client.");
	assert.deepEqual(shot.promptGuidelines, ["Use desktop_screenshot to see what the user sees.", "desktop_screenshot: Ask before capturing private windows."], "a guideline that does not name its tool gets the name");
	assert.equal(app.registry.get("desktop_open_url").promptGuidelines, undefined);
	assert.deepEqual(modelGuidelines({ name: "x_y", guidelines: ["Use x_y."] }), ["Use x_y."]);
});

test("names held by a built-in, an extension or another provider are rejected; the rest register", async (t) => {
	const app = harness(t);
	await app.invoke("set_host_tools", { provider: "phone", tools: [spec("phone_camera")] });
	const response = await app.invoke("set_host_tools", { provider: "desktop", tools: [spec("read"), spec("gentle_todo"), spec("phone_camera"), spec("desktop_clip")] });
	assert.deepEqual(response.data, {
		registered: ["desktop_clip"],
		rejected: [
			{ name: "read", reason: "A built-in or extension tool already has this name" },
			{ name: "gentle_todo", reason: "A built-in or extension tool already has this name" },
			{ name: "phone_camera", reason: "phone already provides a host tool with this name" },
		],
	});
	assert.equal(app.registry.get("phone_camera").exposure, "direct", "the first provider keeps its tool");
	assert.equal(app.registry.has("read"), false, "a built-in is never overridden");
});

test("a provider's new set replaces its old one; dropped and unregistered tools become hidden and free", async (t) => {
	const app = harness(t);
	await app.invoke("set_host_tools", { provider: "desktop", tools: [spec("desktop_a"), spec("desktop_b")] });
	await app.invoke("set_host_tools", { provider: "desktop", tools: [spec("desktop_b", { description: "Newer b." })] });
	assert.equal(app.registry.get("desktop_a").exposure, "hidden", "Pi cannot drop a tool: hidden is unreachable and never declared");
	assert.equal(app.registry.get("desktop_a").promptGuidelines, undefined);
	assert.equal(app.registry.get("desktop_b").exposure, "direct");
	assert.equal(app.registry.get("desktop_b").description, "Newer b.");
	const empty = await app.invoke("set_host_tools", { provider: "desktop", tools: [] });
	assert.deepEqual(empty.data, { registered: [], rejected: [] });
	assert.equal(app.registry.get("desktop_b").exposure, "hidden");
	const other = await app.invoke("set_host_tools", { provider: "phone", tools: [spec("desktop_a")] });
	assert.deepEqual(other.data, { registered: ["desktop_a"], rejected: [] }, "a hidden host tool name is not a collision");
	assert.equal(app.registry.get("desktop_a").exposure, "direct");
});

test("invalid set_host_tools leaves the registry untouched", async (t) => {
	const app = harness(t);
	await app.invoke("set_host_tools", { provider: "desktop", tools: [spec("desktop_a")] });
	const response = await app.invoke("set_host_tools", { provider: "desktop", tools: [spec("desktop_a"), spec("BAD")] });
	assert.equal(response.ok, false);
	assert.equal(response.error.code, "invalid_request");
	assert.equal(app.registry.get("desktop_a").exposure, "direct");
});

// ---- Calls ----

async function registerOne(app: ReturnType<typeof harness>, name = "desktop_shot") {
	await app.invoke("set_host_tools", { provider: "desktop", tools: [spec(name)] });
	return app.registry.get(name);
}

test("a call emits host_tool_call; the first result settles it, a second is already_answered, a stranger unknown_call", async (t) => {
	const app = harness(t);
	const tool = await registerOne(app);
	const pending = tool.execute("model-call-1", { region: "main" }, new AbortController().signal, undefined, {});
	assert.deepEqual(app.events("host_tool_call"), [{ callId: "call-1", provider: "desktop", tool: "desktop_shot", args: { region: "main" } }]);
	assert.equal(app.timers.size, 1, "the 10-minute cap is armed");
	const accepted = await app.invoke("host_tool_result", { callId: "call-1", content: [{ type: "text", text: "captured" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] });
	assert.deepEqual(accepted.data, { accepted: true });
	assert.deepEqual(await pending, { content: [{ type: "text", text: "captured" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], details: { provider: "desktop", callId: "call-1" } });
	assert.equal(app.timers.size, 0, "the cap is disarmed");
	assert.deepEqual((await app.invoke("host_tool_result", { callId: "call-1", content: [{ type: "text", text: "again" }] })).error, ALREADY_ANSWERED);
	assert.deepEqual((await app.invoke("host_tool_result", { callId: "nope", content: [{ type: "text", text: "x" }] })).error, UNKNOWN_CALL);
	assert.deepEqual(app.events("host_tool_cancel"), []);
});

test("isError reaches Pi as an error result the model reads", async (t) => {
	const app = harness(t);
	const tool = await registerOne(app);
	const pending = tool.execute("m", { region: "x" }, undefined, undefined, {});
	await app.invoke("host_tool_result", { callId: "call-1", content: [{ type: "text", text: "Screen recording is off" }], isError: true });
	assert.deepEqual(await pending, { content: [{ type: "text", text: "Screen recording is off" }], details: { provider: "desktop", callId: "call-1" }, isError: true });
});

test("aborting the turn cancels the call: host_tool_cancel goes out and a late result is already_answered", async (t) => {
	const app = harness(t);
	const tool = await registerOne(app);
	const abort = new AbortController();
	const pending = tool.execute("m", { region: "x" }, abort.signal, undefined, {});
	abort.abort();
	const result = await pending;
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /desktop_shot was cancelled/);
	assert.deepEqual(app.events("host_tool_cancel"), [{ callId: "call-1" }]);
	assert.equal(app.timers.size, 0);
	assert.deepEqual((await app.invoke("host_tool_result", { callId: "call-1", content: [{ type: "text", text: "late" }] })).error, ALREADY_ANSWERED);
	const already = new AbortController();
	already.abort();
	assert.equal((await tool.execute("m2", { region: "x" }, already.signal, undefined, {})).isError, true);
	assert.equal(app.events("host_tool_call").length, 1, "an already aborted call never goes out");
});

test("a call nobody answers fails after 10 minutes and is cancelled on the client", async (t) => {
	const app = harness(t);
	const tool = await registerOne(app);
	const pending = tool.execute("m", { region: "x" }, undefined, undefined, {});
	const [timer] = [...app.timers.values()];
	assert.equal(timer.ms, 10 * 60 * 1000);
	timer.callback();
	const result = await pending;
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, "desktop_shot got no answer from desktop within 10 minutes.");
	assert.deepEqual(app.events("host_tool_cancel"), [{ callId: "call-1" }]);
});

test("session shutdown fails waiting calls and hides every host tool; a stale definition answers offline", async (t) => {
	const app = harness(t);
	const tool = await registerOne(app);
	const pending = tool.execute("m", { region: "x" }, undefined, undefined, {});
	await app.shutdown();
	const result = await pending;
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /session ended/);
	assert.equal(app.registry.get("desktop_shot").exposure, "hidden");
	assert.equal((await tool.execute("m", { region: "x" }, undefined, undefined, {})).isError, true);
	assert.equal(hostToolOfflineText("desktop_shot", "Ismael's Mac"), "desktop_shot runs in Ismael's Mac, which isn't connected right now.");
});

test("host tool requests get larger request caps; every other method keeps 64 KiB", async (t) => {
	const app = harness(t);
	const tool = await registerOne(app);
	const pending = tool.execute("m", { region: "x" }, undefined, undefined, {});
	const big = "A".repeat(2 * 1024 * 1024);
	const accepted = await app.invoke("host_tool_result", { callId: "call-1", content: [{ type: "image", data: big, mimeType: "image/png" }] });
	assert.deepEqual(accepted.data, { accepted: true });
	assert.equal(((await pending).content[0] as { data: string }).data.length, big.length);
	const before = app.widgets.length;
	await app.raw(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "big-snapshot", method: "get_snapshot", params: { pad: "x".repeat(70 * 1024) } }));
	assert.deepEqual(JSON.parse(app.widgets[before]).error.code, "invalid_request");
	assert.equal(JSON.parse(app.widgets[before]).requestId, null);
	await app.raw(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "huge", method: "host_tool_result", params: { callId: "x", content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }] } }));
	assert.equal(JSON.parse(app.widgets.at(-1)!).requestId, null, "over 9 MiB the request is refused before parsing");
});

// ---- A real Pi session ----

interface RecordedRequest { systemPrompt: string; tools: string[]; toolResults: Array<{ name: string; isError: boolean; content: unknown[] }> }

async function realSession(t: test.TestContext) {
	setInteractiveHost(t);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-host-tools-")));
	mkdirSync(join(root, "profile"));
	const cwd = join(root, "repo");
	mkdirSync(cwd);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sdk = await import("@earendil-works/pi-coding-agent");
	const ai = await import("@earendil-works/pi-ai");
	const requests: RecordedRequest[] = [];
	const queue: Array<{ name: string; arguments: JsonObject } | undefined> = [];
	let calls = 0;
	const model = { id: "driver", name: "Local driver", provider: "host-fixture", api: "host-fixture", baseUrl: "http://invalid.local", reasoning: false, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;
	const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", packages: [] });
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
	const loader = new sdk.DefaultResourceLoader({
		cwd, agentDir: join(root, "profile"), settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi: ExtensionAPI) => {
			desktopRpc(pi);
			pi.registerProvider("host-fixture", {
				api: "host-fixture", apiKey: "fixture-only", baseUrl: "http://invalid.local",
				models: [{ id: model.id, name: model.name, reasoning: false, input: ["text", "image"], cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
				streamSimple(_model, context) {
					requests.push({
						systemPrompt: ai.getCurrentSystemPrompt(context.messages) ?? "",
						tools: (ai.getCurrentTools(context.messages) ?? []).map((tool) => tool.name),
						toolResults: context.messages.flatMap((message) => message.role === "toolResult" ? [{ name: message.toolName, isError: message.isError, content: message.content }] : []),
					});
					const request = queue.shift();
					calls += 1;
					const stream = ai.createAssistantMessageEventStream();
					const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "pending" as never, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
					queueMicrotask(() => {
						stream.push({ type: "start", partial: message });
						if (request) {
							const toolCall: ToolCall = { type: "toolCall", id: `model-${calls}`, ...request };
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
		sessionManager: sdk.SessionManager.inMemory(cwd), settingsManager: settings,
	});
	const widgets: any[] = [];
	const waiters: Array<{ match: (line: any) => boolean; resolve: (line: any) => void }> = [];
	// Only the Desktop widget matters here; Pi copies the context's own methods, so this is a plain object.
	const ui = {
		setWidget(widgetKey: string, lines: unknown) {
			if (widgetKey !== "gentle-desktop-rpc" || !Array.isArray(lines)) return;
			const line = JSON.parse(lines[0]);
			widgets.push(line);
			for (const waiter of [...waiters]) if (waiter.match(line)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(line); }
		},
	};
	const errors: string[] = [];
	await session.bindExtensions({ mode: "rpc", uiContext: ui as never, onError: (error) => errors.push(error.error) });
	t.after(async () => {
		await session.abort();
		session.dispose();
	});
	let request = 0;
	const next = (match: (line: any) => boolean) => {
		const found = widgets.find(match);
		if (found) return Promise.resolve(found);
		const { promise, resolve } = Promise.withResolvers<any>();
		waiters.push({ match, resolve });
		return promise;
	};
	return {
		session,
		requests,
		queue,
		errors,
		next,
		async desktop(method: string, params: Record<string, unknown>) {
			request += 1;
			const requestId = `real-${request}`;
			const answered = next((line) => line.kind === "response" && line.requestId === requestId);
			await session.prompt(`/gentle:desktop ${JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params })}`, { source: "rpc" });
			return answered;
		},
	};
}

test("real Pi: a registered host tool and its guidelines reach the next request, the call round-trips, unregistering removes both", { timeout: 60_000 }, async (t) => {
	const run = await realSession(t);
	const guideline = "Use desktop_screenshot when the user mentions what is on their screen.";
	const registered = await run.desktop("set_host_tools", { provider: "gentle-desktop", tools: [spec("desktop_screenshot", { guidelines: [guideline] })] });
	assert.deepEqual(registered.data, { registered: ["desktop_screenshot"], rejected: [] });
	const collided = await run.desktop("set_host_tools", { provider: "phone", tools: [spec("bash")] });
	assert.deepEqual(collided.data.rejected, [{ name: "bash", reason: "A built-in or extension tool already has this name" }], "Pi's own tool list decides collisions");

	run.queue.push({ name: "desktop_screenshot", arguments: { region: "main" } }, undefined);
	const turn = run.session.prompt("What is on my screen?", { source: "rpc" });
	const call = await run.next((line) => line.kind === "event" && line.event === "host_tool_call");
	assert.deepEqual({ ...call.data, callId: typeof call.data.callId }, { callId: "string", provider: "gentle-desktop", tool: "desktop_screenshot", args: { region: "main" } });
	const answered = await run.desktop("host_tool_result", { callId: call.data.callId, content: [{ type: "text", text: "A terminal and a browser." }] });
	assert.deepEqual(answered.data, { accepted: true });
	await turn;

	assert.equal(run.requests.length, 2);
	assert.ok(run.requests[0].tools.includes("desktop_screenshot"), "declared to the model in the first request after registration");
	assert.ok(run.requests[0].systemPrompt.includes(guideline), "its guideline is in the system prompt");
	assert.ok(run.requests[0].systemPrompt.includes("Does desktop_screenshot on the client."), "its snippet is in the tool list");
	assert.deepEqual(run.requests[1].toolResults.at(-1), { name: "desktop_screenshot", isError: false, content: [{ type: "text", text: "A terminal and a browser." }] });

	await run.desktop("set_host_tools", { provider: "gentle-desktop", tools: [] });
	run.queue.push(undefined);
	await run.session.prompt("And now?", { source: "rpc" });
	const last = run.requests.at(-1)!;
	assert.equal(last.tools.includes("desktop_screenshot"), false, "no longer declared");
	assert.equal(last.systemPrompt.includes(guideline), false, "its guideline left the system prompt");
	assert.deepEqual(run.errors, []);
});

test("real Pi: aborting the turn sends host_tool_cancel and a late result is already_answered", { timeout: 60_000 }, async (t) => {
	const run = await realSession(t);
	await run.desktop("set_host_tools", { provider: "gentle-desktop", tools: [spec("desktop_screenshot")] });
	run.queue.push({ name: "desktop_screenshot", arguments: { region: "main" } }, undefined);
	const turn = run.session.prompt("Look at my screen.", { source: "rpc" });
	const call = await run.next((line) => line.kind === "event" && line.event === "host_tool_call");
	await run.session.abort();
	await turn;
	const cancel = await run.next((line) => line.kind === "event" && line.event === "host_tool_cancel");
	assert.deepEqual(cancel.data, { callId: call.data.callId });
	const late = await run.desktop("host_tool_result", { callId: call.data.callId, content: [{ type: "text", text: "too late" }] });
	assert.deepEqual(late.error, ALREADY_ANSWERED);
});
