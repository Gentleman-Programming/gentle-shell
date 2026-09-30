import assert from "node:assert/strict";
import test from "node:test";
import {
	createCodemodeExtension,
	initTheme,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionFactory,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, imageFallback, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import quietTools from "../extensions/quiet-tools.ts";
import { decorateCodemodeTool, registerCompactCodemode } from "../lib/codemode-renderer.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

initTheme("dark");
const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text };

function registry() {
	const tools: ToolDefinition[] = [];
	const hooks: unknown[][] = [];
	const pi = {
		registerTool(tool: ToolDefinition) { tools.push(tool); },
		on(...args: unknown[]) { hooks.push(args); },
		getSettings() { return { codemode: { mode: "on" } }; },
		getAllTools() { return []; },
		appendEntry() {},
	} as unknown as ExtensionAPI;
	return { tools, hooks, pi };
}

function registeredCodemode() {
	const { tools, pi } = registry();
	quietTools(pi);
	const tool = tools.find((tool) => tool.name === "codemode");
	assert.ok(tool, "quiet-tools must decorate the public codemode registration");
	return tool;
}

function context(overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
	return {
		args: { code: "await tools.read({path: '/private/argument'});" },
		toolCallId: "code-1", invalidate() {}, lastComponent: undefined, state: {}, cwd: "/fixture",
		executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false,
		isError: false, ...overrides,
	};
}

function result(calls: unknown = [], text = "Script completed\nWall time 0.1 seconds\nOutput:\n"): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: { calls } };
}

function render(tool: ToolDefinition, value: AgentToolResult<unknown>, ctx = context(), width = 100) {
	const call = tool.renderCall!(ctx.args, theme as never, ctx).render(width);
	const body = tool.renderResult!(value, { expanded: ctx.expanded, isPartial: ctx.isPartial }, theme as never, ctx).render(width);
	return [...call, ...body].map(stripAnsi).join("\n");
}

test("quiet tools registers an inactive upstream codemode with compact renderers", () => {
	const tool = registeredCodemode();
	assert.equal(tool.defaultActive, false);
	assert.equal(tool.renderShell, "self");
	assert.equal(tool.name, "codemode");
});

test("public factory runs once and every non-presentation field retains its exact reference", async () => {
	const { pi, tools, hooks } = registry();
	let original: ToolDefinition | undefined;
	let factoryRuns = 0;
	const factory: ExtensionFactory = (api) => {
		factoryRuns++;
		api.on("session_start", () => {});
		return createCodemodeExtension()(new Proxy(api, {
			get(target, property, receiver) {
				if (property === "registerTool") return (tool: ToolDefinition) => { original = tool; api.registerTool(tool); };
				return Reflect.get(target, property, receiver);
			},
		}));
	};
	await registerCompactCodemode(pi, factory);
	assert.equal(factoryRuns, 1);
	assert.equal(tools.length, 1);
	assert.equal(hooks.length, 1);
	assert.ok(original);
	for (const key of Object.keys(original)) {
		if (["renderCall", "renderResult", "renderShell"].includes(key)) continue;
		assert.equal(Reflect.get(tools[0]!, key), Reflect.get(original, key), `${key} must remain upstream-owned`);
	}
	assert.equal(tools[0]!.execute, original.execute);
	assert.equal(tools[0]!.parameters, original.parameters);
	assert.equal(tools[0]!.prepareLoadout, original.prepareLoadout);
	assert.equal(tools[0]!.exposure, original.exposure);
});

test("public loadout modes preserve hidden and deferred exposure policy", async () => {
	for (const mode of ["on", "only"] as const) {
		const { pi, tools } = registry();
		await registerCompactCodemode(pi, createCodemodeExtension({ mode }));
		const tool = tools[0]!;
		const direct = { ...tool, name: "direct_fixture", description: "direct" };
		const deferred = { ...tool, name: "deferred_fixture", description: "deferred" };
		const hidden = { ...tool, name: "hidden_fixture", description: "hidden" };
		const loadout = {
			declared: [tool, direct], callable: [direct, deferred], registered: [tool, direct, deferred, hidden],
			getExposure: (name: string) => name === "deferred_fixture" ? "deferred" : name === "hidden_fixture" ? "hidden" : "direct",
			getNamespace: () => undefined,
		} as unknown as Parameters<NonNullable<ToolDefinition["prepareLoadout"]>>[0];
		const changes = tool.prepareLoadout!(loadout)!;
		assert.deepEqual(changes.hiddenDeclarations, mode === "only" ? ["direct_fixture"] : []);
		assert.doesNotMatch(changes.descriptions!.codemode!, /hidden_fixture/);
		assert.doesNotMatch(changes.descriptions!.codemode!, /### `deferred_fixture`/);
		assert.equal(tool.defaultActive, false);
		assert.equal(tool.exposure, "model-only");
	}
});

test("factory return and lifecycle API registrations pass through unchanged", async () => {
	const { pi, hooks } = registry();
	let completed = false;
	const factory: ExtensionFactory = async (api) => {
		api.on("session_shutdown", () => {});
		await Promise.resolve();
		completed = true;
	};
	const promise = registerCompactCodemode(pi, factory);
	assert.ok(promise instanceof Promise);
	await promise;
	assert.equal(completed, true);
	assert.equal(hooks[0]![0], "session_shutdown");
});

test("decoration preserves execute arguments, updates, return identity and thrown errors", async () => {
	const upstream = registeredCodemode();
	const args = { code: "not executed by this fixture" };
	const signal = new AbortController().signal;
	const ctx = {} as Parameters<ToolDefinition["execute"]>[4];
	const value = result();
	const update = () => {};
	let received: unknown[] = [];
	const original = { ...upstream, execute: async (...values: Parameters<ToolDefinition["execute"]>) => { received = values; return value; } };
	const decorated = decorateCodemodeTool(original);
	assert.equal(decorated.execute, original.execute);
	assert.equal(await decorated.execute("call", args, signal, update, ctx), value);
	assert.deepEqual(received, ["call", args, signal, update, ctx]);
	const failure = new Error("original rejection");
	const rejecting = { ...upstream, execute: async () => { throw failure; } };
	await assert.rejects(decorateCodemodeTool(rejecting).execute("call", args, signal, update, ctx), (error) => error === failure);
});

test("actual upstream execution publishes observed calls and keeps failed-script partial output", async () => {
	const tool = registeredCodemode();
	const updates: AgentToolResult<unknown>[] = [];
	const child = { ...tool, name: "observed", description: "fixture", execute: async () => result() };
	const ctx = {
		tools: [child], sessionManager: { getBranch: () => [] }, modelRegistry: {},
		executeTool: async (name: string, args: unknown) => {
			assert.equal(name, "observed");
			assert.deepEqual(args, { code: "private argument" });
			return { toolCall: { id: "live/1" }, isError: true, result: { content: [{ type: "text", text: "child failure" }], details: undefined } };
		},
	} as unknown as Parameters<ToolDefinition["execute"]>[4];
	const args = { code: "text('partial output'); await tools.observed({code: 'private argument'});" };
	const value = await tool.execute("live", args, undefined, (update) => updates.push(update), ctx);
	const details = value.details as { calls: Array<{ name: string; status: string; durationMs: number }> };
	assert.equal(details.calls[0]!.status, "error");
	assert.equal(details.calls[0]!.name, "observed");
	assert.ok(details.calls[0]!.durationMs >= 0);
	assert.ok(updates.some((update) => (update.details as typeof details).calls[0]?.status === "running"));
	assert.equal(Reflect.get(value, "isError"), true);
	const expanded = render(tool, value, context({ args, expanded: true, isError: true }));
	assert.match(expanded, /partial output/);
	assert.match(expanded, /child failure/);
	assert.match(expanded, /Script failed/);
	assert.match(expanded, /Wall time [\d.]+ seconds/);
});

test("collapsed card shows flat observed order, repeats and durations without arguments or output", () => {
	const calls = [
		{ name: "read", status: "ok", durationMs: 0, args: "private child argument" },
		{ name: "bash", status: "running", durationMs: 1234 },
		{ name: "read", status: "cancelled", durationMs: 5, error: "/private/error payload" },
	];
	const text = render(registeredCodemode(), result(calls, "private output"));
	assert.match(text, /Code/);
	assert.match(text, /ok · read · 0ms[\s\S]*running · bash · 1.2s[\s\S]*cancelled · read · 5ms/);
	assert.doesNotMatch(text, /private|await|path|Wall time|queued|done/);
	assert.equal(text.split("╭").length - 1, 1);
	assert.equal(text.split("╰").length - 1, 1);
});

test("partial metadata never claims overall success and final flags expose script failure", () => {
	const tool = registeredCodemode();
	const partial = render(tool, result([{ name: "read", status: "ok", durationMs: 1 }]), context({ isPartial: true }));
	assert.match(partial, /Code · running/);
	assert.doesNotMatch(partial, /finished|completed|success/);
	const failed = render(tool, result([{ name: "read", status: "ok" }]), context({ isError: true }));
	assert.match(failed, /Code · failed/);
	assert.match(failed, /Script failed/);
	const completedWithChildFailure = render(tool, result([{ name: "read", status: "error", error: "caught" }]));
	assert.match(completedWithChildFailure, /error · read/);
	assert.doesNotMatch(completedWithChildFailure, /Code · success/);
});

test("expanded call and replay use per-call public args, not last-call mutable state", () => {
	const tool = registeredCodemode();
	const first = context({ args: { code: "return 'first JS';" }, expanded: true, state: {} });
	const second = context({ args: { code: "throw Error('second JS');" }, expanded: true, state: {}, isError: true });
	tool.renderCall!(first.args, theme as never, first);
	const secondText = render(tool, result([], "second output"), second);
	const firstText = render(tool, result([], "first output\nWall time 0.3 seconds"), first);
	assert.match(firstText, /first JS/);
	assert.match(firstText, /first output/);
	assert.doesNotMatch(firstText, /second JS|second output/);
	assert.match(secondText, /second JS/);
	assert.match(secondText, /second output/);
	assert.doesNotMatch(secondText, /first/);
	assert.match(render(tool, result([], "replayed"), context({ ...first, state: {} })), /first JS/);
});

test("missing and malformed metadata stays honest, finite and does not infer source calls", () => {
	const tool = registeredCodemode();
	for (const details of [undefined, null, {}, { calls: null }, { calls: "invalid" }]) {
		const value = { ...result(), details };
		const text = render(tool, value);
		assert.match(text, /No observed child calls/);
		assert.doesNotMatch(text, /read|0ms|success/);
	}
	const text = render(tool, result([null, { name: {}, status: "done", durationMs: NaN, error: {} },
		{ name: "bad-time", status: "ok", durationMs: -1 }, { name: "infinity", status: "ok", durationMs: Infinity }]));
	assert.match(text, /status unavailable/);
	assert.match(text, /name unavailable/);
	assert.doesNotMatch(text, /done|NaN|Infinity|-1ms|undefined|\[object Object\]/);
});

test("bounded collapsed children preserve order and disclose failures outside the preview", () => {
	const calls = Array.from({ length: 20 }, (_, index) => ({ name: `child-${index}`, status: index === 19 ? "error" : "ok", error: index === 19 ? "late error" : undefined }));
	const tool = registeredCodemode();
	const text = render(tool, result(calls), context(), 120);
	assert.match(text, /child-0[\s\S]*child-7/);
	assert.match(text, /1 errors\/cancellations reported · 12 more calls/);
	assert.doesNotMatch(text, /child-19|late error/);
	assert.ok(text.split("\n").length <= 12);
	const expanded = render(tool, result(calls), context({ expanded: true }));
	assert.match(expanded, /child-19/);
	assert.match(expanded, /late error/);
});

test("expanded output retains image fallback and full-output locator without mutating the result", () => {
	const tool = registeredCodemode();
	const value: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "first\nlast" }, { type: "image", mimeType: "image/png", data: "fixture" }],
		details: { calls: [], fullOutputPath: "/fixture/full-output.txt" },
	};
	const before = structuredClone(value);
	const collapsed = render(tool, value);
	assert.doesNotMatch(collapsed, /full-output|image\/png|first|last/);
	const expanded = render(tool, value, context({ expanded: true, showImages: false }));
	assert.match(expanded, /first[\s\S]*last/);
	assert.match(expanded, /image\/png/);
	assert.match(expanded, /\/fixture\/full-output.txt/);
	assert.deepEqual(value, before);
});

test("expanded images use text fallback only when host image painting is unavailable", async (t) => {
	const tool = registeredCodemode();
	const originalCapabilities = getCapabilities();
	const value: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "text preserved" }, { type: "image", mimeType: "image/png", data: "fixture" }],
		details: { calls: [] },
	};
	const originalResult = structuredClone(value);
	for (const images of [null, "kitty", "iterm2"] as const) {
		for (const showImages of [true, false]) {
			await t.test(`${images ?? "unsupported"} · showImages=${showImages}`, () => {
				try {
					setCapabilities({ ...originalCapabilities, images });
					const expanded = render(tool, value, context({ expanded: true, showImages }));
					assert.match(expanded, /text preserved/);
					assert.equal(expanded.includes(imageFallback("image/png")), !images || !showImages,
						"fallback must remain visible without host image painting, and must not duplicate a supported image");
					assert.doesNotMatch(render(tool, value, context({ showImages })), /image\/png|text preserved/);
					assert.deepEqual(value, originalResult, "host must retain the original image content");
				} finally {
					setCapabilities(originalCapabilities);
					assert.equal(getCapabilities(), originalCapabilities, "restore the exact owned capability state");
				}
			});
		}
	}
});

test("terminal controls cannot spoof child, code or output rows at narrow and wide widths", () => {
	const tool = registeredCodemode();
	const malicious = "\u001b[2J\u001b]8;;https://invalid\u0007危险🌹\u202e\u2066\u0000\t\r\nforged";
	const value = result([{ name: malicious, status: "error", error: malicious, durationMs: 0 }], malicious);
	for (const width of [0, 1, 2, 3, 4, 5, 8, 12, 24, 80, 180]) {
		for (const expanded of [false, true]) {
			const ctx = context({ args: { code: malicious }, expanded, isError: true });
			const components = [tool.renderCall!(ctx.args, theme as never, ctx), tool.renderResult!(value, { expanded, isPartial: false }, theme as never, ctx)];
			for (const line of components.flatMap((component) => component.render(width))) {
				assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
				assert.doesNotMatch(stripAnsi(line), /[\u0000\u0007\u001b\u202e\u2066\r]/);
				assert.doesNotMatch(line, /\u001b\[2J|https:\/\/invalid/);
			}
		}
	}
});
