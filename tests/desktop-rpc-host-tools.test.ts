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
	DETAILS_TOO_LARGE,
	HOST_TOOL_RESULT_TOO_LARGE,
	hostToolOfflineText,
	INVALID_HOST_MESSAGE,
	INVALID_HOST_TOOL_PROGRESS,
	INVALID_SET_HOST_ACTIVITY,
	INVALID_SET_HOST_CONTEXT,
	MESSAGE_TOO_LARGE,
	modelGuidelines,
	parseHostMessage,
	parseHostToolProgress,
	parseHostToolResult,
	parseSetHostContext,
	parseSetHostTools,
	TOO_MANY_CONTEXTS,
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
	let clock = 1_000_000;
	const sent: Array<{ message: any; options: any }> = [];
	let idle = true;
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut() {},
		on(name: string, handler: any) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== handler));
		},
		events: { on() { return () => {}; }, emit() {} },
		registerTool(definition: any) { registry.set(definition.name, definition); registrations.push(definition); },
		getAllTools() {
			return [{ name: "read" }, { name: "bash" }, { name: "gentle_todo" }, ...[...registry.keys()].map((name) => ({ name }))];
		},
		sendMessage(message: any, options: any) { sent.push({ message, options }); },
	} as unknown as ExtensionAPI;
	desktopRpc(pi, {
		hostTools: {
			timers: {
				setTimeout(callback, ms) { nextTimer += 1; timers.set(nextTimer, { callback, ms }); return nextTimer; },
				clearTimeout(handle) { timers.delete(handle as number); },
			},
			newCallId: () => `call-${(nextCall += 1)}`,
			now: () => clock,
		},
	});
	const widgets: string[] = [];
	const ctx = {
		mode: "rpc",
		cwd: "/x",
		sessionManager: { getCwd: () => "/x", getSessionId: () => "s", getEntries: () => [] },
		ui: { setWidget(_key: string, lines: string[]) { widgets.push(...lines); } },
		isIdle: () => idle,
	};
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	let request = 0;
	const lines = () => widgets.map((line) => JSON.parse(line));
	return {
		registry,
		registrations,
		timers,
		advance(ms: number) { clock += ms; },
		widgets,
		sent,
		setIdle(value: boolean) { idle = value; },
		/** What Pi's `before_agent_start` would collect: one message per handler that returned one. */
		async beforeAgentStart() {
			const messages: any[] = [];
			for (const handler of handlers.get("before_agent_start") ?? []) {
				const result: any = await handler({ type: "before_agent_start", messageType: "user", prompt: "hi" }, ctx);
				if (result?.message) messages.push(result.message);
			}
			return messages;
		},
		async start() { for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx); },
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

test("the Desktop transport advertises the host tool methods and both events once", async (t) => {
	assert.deepEqual([...DESKTOP_HOST_TOOLS_METHODS], ["set_host_tools", "host_tool_result", "host_tool_progress", "host_message", "set_host_context", "set_host_activity"]);
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

test("names held by a built-in or an extension are rejected; another provider's host tool name is shared", async (t) => {
	const app = harness(t);
	await app.invoke("set_host_tools", { provider: "phone", tools: [spec("device_camera")] });
	const response = await app.invoke("set_host_tools", { provider: "desktop", tools: [spec("read"), spec("gentle_todo"), spec("device_camera"), spec("desktop_clip")] });
	assert.deepEqual(response.data, {
		registered: ["device_camera", "desktop_clip"],
		rejected: [
			{ name: "read", reason: "A built-in or extension tool already has this name" },
			{ name: "gentle_todo", reason: "A built-in or extension tool already has this name" },
		],
	});
	assert.equal(app.registry.get("device_camera").exposure, "direct");
	assert.equal(app.registry.has("read"), false, "a built-in is never overridden");
});

test("two providers of one name: the newest definition is the one tool the model sees; unregistering falls back", async (t) => {
	const app = harness(t);
	await app.invoke("set_host_tools", { provider: "mac", tools: [spec("device_screenshot", { description: "Mac screenshot." })] });
	await app.invoke("set_host_tools", { provider: "phone", tools: [spec("device_screenshot", { description: "Phone screenshot.", parameters: { type: "object", properties: {} } })] });
	assert.equal(app.registry.get("device_screenshot").description, "Phone screenshot.", "the most recent registration's definition");
	assert.deepEqual(app.registry.get("device_screenshot").parameters, { type: "object", properties: {} });
	await app.invoke("set_host_tools", { provider: "mac", tools: [spec("device_screenshot", { description: "Mac screenshot, again." })] });
	assert.equal(app.registry.get("device_screenshot").description, "Mac screenshot, again.", "registering again makes it the newest");
	await app.invoke("set_host_tools", { provider: "mac", tools: [] });
	assert.equal(app.registry.get("device_screenshot").description, "Phone screenshot.", "the next provider's definition takes over");
	assert.equal(app.registry.get("device_screenshot").exposure, "direct");
	const pending = app.registry.get("device_screenshot").execute("m", {}, undefined, undefined, {});
	assert.equal(app.events("host_tool_call").at(-1).provider, "phone", "calls go to the provider that still offers it");
	await app.invoke("host_tool_result", { callId: "call-1", content: [{ type: "text", text: "ok" }] });
	await pending;
	await app.invoke("set_host_tools", { provider: "phone", tools: [] });
	assert.equal(app.registry.get("device_screenshot").exposure, "hidden", "the last provider leaving hides it");
});

test("a call goes to the most recently active connected provider, else the next, else the newest registration", async (t) => {
	const app = harness(t);
	await app.invoke("set_host_tools", { provider: "mac", tools: [spec("device_screenshot")] });
	await app.invoke("set_host_tools", { provider: "phone", tools: [spec("device_screenshot")] });
	await app.invoke("set_host_tools", { provider: "watch", tools: [spec("watch_face")] });
	const tool = app.registry.get("device_screenshot");
	const callTo = async () => {
		const pending = tool.execute("m", { region: "x" }, undefined, undefined, {});
		const call = app.events("host_tool_call").at(-1);
		await app.invoke("host_tool_result", { callId: call.callId, content: [{ type: "text", text: "ok" }] });
		await pending;
		return call.provider;
	};
	assert.equal(await callTo(), "phone", "over stdio (no activity list): the newest registration");
	assert.deepEqual((await app.invoke("set_host_activity", { providers: ["mac", "phone"] })).data, { set: true });
	assert.equal(await callTo(), "mac", "the last active device runs it");
	await app.invoke("set_host_activity", { providers: ["watch", "phone", "mac"] });
	assert.equal(await callTo(), "phone", "the most recently active one that offers the tool");
	await app.invoke("set_host_activity", { providers: ["mac"] });
	assert.equal(await callTo(), "mac", "the phone went offline: the next active provider that is connected");
	await app.invoke("set_host_activity", { providers: ["watch"] });
	assert.equal(await callTo(), "phone", "nobody offering it is connected: the newest registration (serve answers it offline at once)");
	for (const params of [{}, { providers: "mac" }, { providers: [""] }, { providers: ["a", "a"] }, { providers: Array.from({ length: 65 }, (_, i) => `p${i}`) }, { providers: [], extra: 1 }]) {
		assert.deepEqual((await app.invoke("set_host_activity", params)).error, INVALID_SET_HOST_ACTIVITY, JSON.stringify(params).slice(0, 80));
	}
	await app.invoke("set_host_activity", { providers: ["mac"] });
	await app.shutdown();
	await app.start();
	await app.invoke("set_host_tools", { provider: "mac", tools: [spec("device_screenshot")] });
	await app.invoke("set_host_tools", { provider: "phone", tools: [spec("device_screenshot")] });
	const fresh = app.registry.get("device_screenshot");
	const pending = fresh.execute("m", { region: "x" }, undefined, undefined, {});
	assert.equal(app.events("host_tool_call").at(-1).provider, "phone", "a session change forgets the activity list");
	await app.invoke("host_tool_result", { callId: app.events("host_tool_call").at(-1).callId, content: [{ type: "text", text: "ok" }] });
	await pending;
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
	assert.deepEqual(other.data, { registered: ["desktop_a"], rejected: [] }, "a hidden host tool name is free");
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

test("host_tool_progress restarts the 10-minute deadline as often as it comes; without it the call still fails", async (t) => {
	const app = harness(t);
	const tool = await registerOne(app);
	const pending = tool.execute("m", { region: "x" }, undefined, undefined, {});
	const [first] = [...app.timers.keys()];
	for (let beat = 1; beat <= 3; beat += 1) {
		app.advance(9 * 60 * 1000);
		const progress = await app.invoke("host_tool_progress", { callId: "call-1", ...(beat === 2 ? { message: "waiting for review" } : {}) });
		assert.deepEqual(progress.data, { extended: true, deadlineMs: 1_000_000 + beat * 9 * 60 * 1000 + 10 * 60 * 1000 });
		assert.equal(app.timers.size, 1, "one deadline armed at a time");
		assert.equal([...app.timers.values()][0].ms, 10 * 60 * 1000);
	}
	assert.equal(app.timers.has(first), false, "the original deadline was cleared");
	const [timer] = [...app.timers.values()];
	timer.callback();
	const result = await pending;
	assert.equal(result.content[0].text, "desktop_shot got no answer from desktop within 10 minutes.");
	assert.deepEqual(app.events("host_tool_cancel"), [{ callId: "call-1" }]);
	assert.deepEqual((await app.invoke("host_tool_progress", { callId: "call-1" })).error, ALREADY_ANSWERED);
	assert.deepEqual((await app.invoke("host_tool_progress", { callId: "nope" })).error, UNKNOWN_CALL);
	assert.equal(app.timers.size, 0, "progress on a settled call arms nothing");
});

test("host_tool_progress validates callId and an optional message up to 512 characters; it keeps 64 KiB", async (t) => {
	assert.equal(parseHostToolProgress({ callId: "c" }).ok, true);
	assert.equal(parseHostToolProgress({ callId: "c", message: "x".repeat(512) }).ok, true);
	for (const params of [{}, { callId: "" }, { callId: 1 }, { callId: "x".repeat(129) }, { callId: "c", message: "x".repeat(513) }, { callId: "c", message: 1 }, { callId: "c", extra: true }]) {
		assert.deepEqual(errorOf(parseHostToolProgress(params as Record<string, unknown>)), INVALID_HOST_TOOL_PROGRESS);
	}
	const app = harness(t);
	const before = app.widgets.length;
	await app.raw(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "big-progress", method: "host_tool_progress", params: { callId: "c", pad: "x".repeat(70 * 1024) } }));
	assert.equal(JSON.parse(app.widgets[before]).requestId, null, "over 64 KiB the request is refused before parsing");
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
	await app.raw(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "huge", method: "host_tool_result", params: { callId: "x", content: [{ type: "text", text: "x".repeat(10 * 1024 * 1024) }] } }));
	assert.equal(JSON.parse(app.widgets.at(-1)!).requestId, null, "over 10 MiB the request is refused before parsing");
});

// ---- Result details, host messages and host context ----

function errorOf(parsed: { ok: true } | { ok: false; error: unknown }): unknown {
	return "error" in parsed ? parsed.error : undefined;
}

test("host_tool_result details: a JSON object up to 1 MiB becomes the Pi tool result's details", async (t) => {
	assert.equal(parseHostToolResult({ callId: "c", content: [{ type: "text", text: "x" }], details: [] }).ok, false);
	assert.equal(parseHostToolResult({ callId: "c", content: [{ type: "text", text: "x" }], details: "x" }).ok, false);
	assert.deepEqual(parseHostToolResult({ callId: "c", content: [{ type: "text", text: "x" }], details: { pad: "x".repeat(1024 * 1024) } }), { ok: false, error: DETAILS_TOO_LARGE });
	const app = harness(t);
	const tool = await registerOne(app);
	const pending = tool.execute("m", { region: "x" }, undefined, undefined, {});
	const details = { surface: { id: "s1", version: 3 }, rows: [1, 2] };
	assert.deepEqual((await app.invoke("host_tool_result", { callId: "call-1", content: [{ type: "text", text: "drawn" }], details })).data, { accepted: true });
	assert.deepEqual(await pending, { content: [{ type: "text", text: "drawn" }], details });
});

test("host_message validates its type, content, delivery and details", () => {
	const ok = { customType: "host.genui.event", content: "clicked", display: true, deliver: "auto" };
	assert.deepEqual(parseHostMessage(ok), { ok: true, value: ok });
	assert.equal(parseHostMessage({ ...ok, customType: `host.${"a".repeat(64)}` }).ok, true, "64 characters after host. are allowed");
	for (const params of [
		{ ...ok, customType: "genui.event" },
		{ ...ok, customType: "host." },
		{ ...ok, customType: "host.Upper" },
		{ ...ok, customType: `host.${"a".repeat(65)}` },
		{ ...ok, content: 1 },
		{ ...ok, display: "yes" },
		{ ...ok, deliver: "now" },
		{ ...ok, triggerTurn: 1 },
		{ ...ok, details: [] },
		{ ...ok, extra: true },
		{ customType: "host.x", content: "", deliver: "auto" },
	]) assert.deepEqual(errorOf(parseHostMessage(params)), INVALID_HOST_MESSAGE, JSON.stringify(params).slice(0, 120));
	assert.equal(parseHostMessage({ ...ok, content: "é".repeat(32 * 1024) }).ok, true, "64 KiB of UTF-8 is allowed");
	assert.deepEqual(parseHostMessage({ ...ok, content: `${"é".repeat(32 * 1024)}x` }), { ok: false, error: MESSAGE_TOO_LARGE });
	assert.deepEqual(parseHostMessage({ ...ok, details: { pad: "x".repeat(1024 * 1024) } }), { ok: false, error: DETAILS_TOO_LARGE });
});

test("host_message calls pi.sendMessage: auto starts a turn when idle and steers while streaming; other modes pass through", async (t) => {
	const app = harness(t);
	const base = { customType: "host.genui.event", content: "clicked Save", display: true, details: { surface: "s1" } };
	assert.deepEqual((await app.invoke("host_message", { ...base, deliver: "auto" })).data, { delivered: true });
	await app.invoke("host_message", { ...base, deliver: "auto", triggerTurn: false });
	app.setIdle(false);
	await app.invoke("host_message", { ...base, deliver: "auto" });
	await app.invoke("host_message", { ...base, deliver: "auto", triggerTurn: false });
	await app.invoke("host_message", { ...base, deliver: "followUp" });
	await app.invoke("host_message", { ...base, deliver: "nextTurn" });
	await app.invoke("host_message", { ...base, deliver: "steer", triggerTurn: true });
	assert.deepEqual(app.sent.map((entry) => entry.options), [
		{ triggerTurn: true },
		{ triggerTurn: false },
		{ deliverAs: "steer" },
		{ deliverAs: "steer" },
		{ deliverAs: "followUp" },
		{ deliverAs: "nextTurn" },
		{ deliverAs: "steer", triggerTurn: true },
	]);
	assert.deepEqual(app.sent[0].message, base, "the message reaches Pi as sent");
	const invalid = await app.invoke("host_message", { ...base, deliver: "later" });
	assert.deepEqual(invalid.error, INVALID_HOST_MESSAGE);
	assert.equal(app.sent.length, 7, "an invalid message never reaches Pi");
});

test("set_host_context injects one hidden message per provider before each run; empty clears; a session change drops all", async (t) => {
	assert.equal(parseSetHostContext({ provider: "app", content: "" }).ok, true, "empty clears");
	for (const params of [{ content: "x" }, { provider: "", content: "x" }, { provider: "app", content: 1 }, { provider: "app", content: "x", details: [] }, { provider: "app", content: "x", extra: 1 }]) {
		assert.deepEqual(errorOf(parseSetHostContext(params)), INVALID_SET_HOST_CONTEXT, JSON.stringify(params));
	}
	assert.deepEqual(parseSetHostContext({ provider: "app", content: "x".repeat(64 * 1024 + 1) }), { ok: false, error: MESSAGE_TOO_LARGE });
	assert.deepEqual(parseSetHostContext({ provider: "app", content: "x", details: { pad: "x".repeat(1024 * 1024) } }), { ok: false, error: DETAILS_TOO_LARGE });

	const app = harness(t);
	assert.deepEqual(await app.beforeAgentStart(), []);
	assert.deepEqual((await app.invoke("set_host_context", { provider: "app", content: "Booted: iPhone 16", details: { devices: 1 } })).data, { set: true });
	await app.invoke("set_host_context", { provider: "phone", content: "Battery low" });
	assert.deepEqual(await app.beforeAgentStart(), [
		{ customType: "host.context.app", content: "Booted: iPhone 16", display: false, details: { devices: 1 } },
		{ customType: "host.context.phone", content: "Battery low", display: false },
	]);
	await app.invoke("set_host_context", { provider: "app", content: "Booted: Pixel 9" });
	assert.deepEqual(await app.beforeAgentStart(), [
		{ customType: "host.context.app", content: "Booted: Pixel 9", display: false },
		{ customType: "host.context.phone", content: "Battery low", display: false },
	], "a new set replaces the provider's context and details");
	await app.invoke("set_host_context", { provider: "phone", content: "" });
	assert.deepEqual((await app.beforeAgentStart()).map((m) => m.customType), ["host.context.app"]);
	await app.shutdown();
	await app.start();
	assert.deepEqual(await app.beforeAgentStart(), [], "a session change clears every host context");
	for (let i = 0; i < 16; i += 1) assert.equal((await app.invoke("set_host_context", { provider: `p${i}`, content: "x" })).ok, true);
	assert.deepEqual((await app.invoke("set_host_context", { provider: "p16", content: "x" })).error, TOO_MANY_CONTEXTS);
	assert.equal((await app.invoke("set_host_context", { provider: "p0", content: "y" })).ok, true, "an existing provider may still update");
});

test("host_message and set_host_context get a 2 MiB request cap", async (t) => {
	const app = harness(t);
	const response = await app.invoke("set_host_context", { provider: "app", content: "x", details: { pad: "x".repeat(900 * 1024) } });
	assert.deepEqual(response.data, { set: true });
	const message = await app.invoke("host_message", { customType: "host.genui.event", content: "x", display: false, deliver: "nextTurn", details: { pad: "x".repeat(900 * 1024) } });
	assert.deepEqual(message.data, { delivered: true });
});

// ---- A real Pi session ----

interface RecordedRequest { systemPrompt: string; tools: string[]; toolResults: Array<{ name: string; isError: boolean; content: unknown[] }>; texts: string[] }

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
						// Custom messages reach the model as user messages; their text is what the model reads.
						texts: context.messages.flatMap((message) => message.role === "user" ? (typeof message.content === "string" ? [message.content] : message.content.flatMap((part) => part.type === "text" ? [part.text] : [])) : []),
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

type RealRun = Awaited<ReturnType<typeof realSession>>;

/** Resolves when the next run Pi starts on its own (a triggered custom message) has ended. */
function nextRunEnd(run: RealRun): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const off = run.session.subscribe((event) => {
		if (event.type !== "agent_end") return;
		off();
		resolve();
	});
	return promise;
}

function customEntries(run: RealRun) {
	return run.session.sessionManager.getEntries().flatMap((entry) => entry.type === "custom_message" ? [{ customType: entry.customType, content: entry.content, display: entry.display, details: entry.details }] : []);
}

test("real Pi: host_message starts a turn when idle and is persisted; host context is injected hidden before each run until cleared", { timeout: 60_000 }, async (t) => {
	const run = await realSession(t);
	assert.deepEqual((await run.desktop("set_host_context", { provider: "app", content: "Simulators: iPhone 16 booted", details: { booted: ["iPhone 16"] } })).data, { set: true });
	run.queue.push(undefined);
	const ended = nextRunEnd(run);
	const sent = await run.desktop("host_message", { customType: "host.genui.event", content: "The user clicked Save on surface s1.", display: true, details: { surface: "s1" }, deliver: "auto" });
	assert.deepEqual(sent.data, { delivered: true });
	await ended;
	await run.session.waitForIdle();
	assert.deepEqual(run.requests[0].texts, ["The user clicked Save on surface s1.", "Simulators: iPhone 16 booted"], "the message starts the run and the context rides along");
	assert.deepEqual(customEntries(run), [
		{ customType: "host.genui.event", content: "The user clicked Save on surface s1.", display: true, details: { surface: "s1" } },
		{ customType: "host.context.app", content: "Simulators: iPhone 16 booted", display: false, details: { booted: ["iPhone 16"] } },
	], "both are session entries, so a client rebuilds its state from get_entries");

	await run.desktop("host_message", { customType: "host.genui.state", content: "Surface s1 closed.", display: false, deliver: "auto", triggerTurn: false });
	await run.session.waitForIdle();
	assert.equal(run.requests.length, 1, "triggerTurn false only records the message");
	assert.equal(customEntries(run).at(-1)?.customType, "host.genui.state");

	await run.desktop("set_host_context", { provider: "app", content: "" });
	run.queue.push(undefined);
	await run.session.prompt("Anything else?", { source: "rpc" });
	assert.equal(run.requests.length, 2);
	assert.equal(run.requests[1].texts.filter((text) => text.startsWith("Simulators:")).length, 1, "a cleared context is not injected again");
	assert.equal(customEntries(run).filter((entry) => entry.customType === "host.context.app").length, 1);
	assert.deepEqual(run.errors, []);
});

test("real Pi: host_message during a running turn steers it; a result's details become the tool result's details", { timeout: 60_000 }, async (t) => {
	const run = await realSession(t);
	await run.desktop("set_host_tools", { provider: "gentle-desktop", tools: [spec("desktop_screenshot")] });
	run.queue.push({ name: "desktop_screenshot", arguments: { region: "main" } }, undefined);
	const turn = run.session.prompt("Look at my screen.", { source: "rpc" });
	const call = await run.next((line) => line.kind === "event" && line.event === "host_tool_call");
	assert.deepEqual((await run.desktop("host_message", { customType: "host.genui.event", content: "The user also opened Settings.", display: true, deliver: "auto" })).data, { delivered: true });
	const details = { image: { width: 1280, height: 800 }, window: "Terminal" };
	await run.desktop("host_tool_result", { callId: call.data.callId, content: [{ type: "text", text: "A terminal." }], details });
	await turn;
	assert.equal(run.requests.length, 2, "the steered message joins the running turn instead of starting another");
	assert.equal(run.requests[1].texts.at(-1), "The user also opened Settings.");
	const result = run.session.messages.find((message) => message.role === "toolResult");
	assert.deepEqual(result && "details" in result ? result.details : undefined, details);
	assert.deepEqual(run.errors, []);
});
