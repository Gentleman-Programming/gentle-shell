import assert from "node:assert/strict";
import test from "node:test";
import {
	createCodemodeExtension,
	initTheme,
	keyHint,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionFactory,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, imageFallback, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import quietTools from "../extensions/quiet-tools.ts";
import { decorateCodemodeTool, registerCompactCodemode } from "../lib/codemode-renderer.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
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
	const fixture = {
		args: { code: "await tools.read({path: '/private/argument'});" },
		toolCallId: "code-1", invalidate() {}, lastComponent: undefined, state: {}, cwd: "/fixture",
		executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false,
		isError: false, durationMs: undefined, outputPad: 0, ...overrides,
	};
	return fixture;
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
			getPromptGuidelines: () => [],
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

test("Code retains its distinct lambda icon in the top rule at every host outcome", () => {
	const tool = registeredCodemode();
	for (const overrides of [{}, { isPartial: true }, { isError: true }, { expanded: true }]) {
		const ctx = context(overrides);
		const rows = tool.renderCall!(ctx.args, theme as never, ctx).render(100).map(stripAnsi);
		assert.match(rows[0], /^╭─ λ Code /);
		assert.match(rows[0], /to (?:expand|collapse) ╮$/);
		for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
			assert.ok(tool.renderCall!(ctx.args, theme as never, ctx).render(width).every((row) => visibleWidth(row) <= width));
		}
	}
});

test("collapsed card shows flat observed order, repeats, durations and useful output without arguments", () => {
	const calls = [
		{ name: "read", status: "ok", durationMs: 0, args: "private child argument" },
		{ name: "bash", status: "running", durationMs: 1234 },
		{ name: "read", status: "cancelled", durationMs: 5, error: "/private/error payload" },
	];
	const text = render(registeredCodemode(), result(calls, "private output"));
	assert.match(text, /Code/);
	assert.match(text, /ok · read · 0ms[\s\S]*running · bash · 1.2s[\s\S]*cancelled · read · 5ms/);
	assert.match(text, /private output/);
	assert.match(text, /\/private\/error payload/);
	assert.doesNotMatch(text, /private child argument|await|queued|done|finished/);
	assert.equal(text.split("╭").length - 1, 1);
	assert.equal(text.split("╰").length - 1, 1);
});

test("partial metadata never claims overall success and final flags expose script failure", () => {
	const tool = registeredCodemode();
	const partial = render(tool, result([{ name: "read", status: "ok", durationMs: 1 }], "partial output"), context({ isPartial: true }));
	assert.match(partial, /Code/);
	assert.doesNotMatch(partial, /finished|completed|success/);
	const failed = render(tool, result([{ name: "read", status: "ok" }]), context({ isError: true }));
	assert.match(failed, /Code/);
	assert.doesNotMatch(failed, /Code · failed/);
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
	assert.match(text, /child-19[\s\S]*late error/);
	assert.ok(text.split("\n").length <= 17);
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
	assert.match(collapsed, /first[\s\S]*last/);
	assert.match(collapsed, /image\/png/);
	assert.match(collapsed, /full-output/);
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
					const collapsed = render(tool, value, context({ showImages }));
					assert.match(collapsed, /text preserved/);
					assert.equal(collapsed.includes(imageFallback("image/png")), !images || !showImages);
					assert.deepEqual(value, originalResult, "host must retain the original image content");
				} finally {
					setCapabilities(originalCapabilities);
					assert.equal(getCapabilities(), originalCapabilities, "restore the exact owned capability state");
				}
			});
		}
	}
});

test("collapsed Code skips upstream bookkeeping to preview the actual final output", () => {
	const text = render(registeredCodemode(), result([], "Script completed\nWall time 0.1 seconds\nOutput:\nactual answer\nsecond detail\nthird detail\nhidden detail"));
	assert.match(text, /actual answer[\s\S]*second detail[\s\S]*third detail/);
	assert.doesNotMatch(text, /Script completed|Wall time|Output:|hidden detail/);
});

test("Code components repaint semantic colors after theme invalidation without background fill", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	setCardStyle(CARD_STYLE.NEON);
	const tool = registeredCodemode();
	let paint = "\x1b[31m";
	const themed = { fg: (_role: string, text: string) => `${paint}${text}\x1b[0m`, bg: (_role: string, text: string) => `\x1b[44m${text}\x1b[49m` };
	const ctx = context({ isError: true });
	const components = [tool.renderCall!(ctx.args, themed as never, ctx), tool.renderResult!(result([{ name: "read", status: "error", error: "denied" }], "failure detail"), { expanded: false, isPartial: false }, themed as never, ctx)];
	const first = components.flatMap((component) => component.render(100)).join("\n");
	assert.match(first, /\x1b\[31m/);
	paint = "\x1b[35m";
	for (const component of components) component.invalidate();
	const changed = components.flatMap((component) => component.render(100)).join("\n");
	assert.doesNotMatch(changed, /\x1b\[31m|\x1b\[44m/);
	assert.match(changed, /\x1b\[35m/);
	assert.equal(stripAnsi(first), stripAnsi(changed));
});

test("collapsed Code output has a fixed physical row budget and semantic tones", () => {
	const tool = registeredCodemode();
	for (const [isError, isPartial, expected] of [[false, false, "border"], [true, false, "error"], [false, true, "warning"]] as const) {
		const roles: string[] = [];
		const painted = { fg: (role: string, text: string) => { roles.push(role); return text; } };
		const ctx = context({ isError, isPartial });
		const value = result([], "useful 界🌹 e\u0301 " + "x".repeat(800) + "\nlast");
		for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8, 24, 120]) {
			const rows = tool.renderResult!(value, { expanded: false, isPartial }, painted as never, ctx).render(width);
			assert.ok(rows.length <= 6);
			assert.ok(rows.every((row) => visibleWidth(row) <= width));
			assert.equal(rows.filter((row) => row.startsWith("╰")).length, width ? 1 : 0);
		}
		assert.ok(roles.includes(expected));
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

// Float style: one borderless panel across the call and result components,
// with exactly one separator between the heading and whatever body comes first.
const floatTheme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => `\x1b[38;5;203m${text}\x1b[39m`,
	bg: (color: string, text: string) => `\x1b[48;5;${color === "toolErrorBg" ? 52 : 22}m${text}\x1b[49m`,
};

function renderFloat(tool: ToolDefinition, value: AgentToolResult<unknown>, ctx: ToolRenderContext, width = 70) {
	setCardStyle(CARD_STYLE.FLOAT);
	try {
		const call = tool.renderCall!(ctx.args, floatTheme as never, ctx).render(width);
		const body = tool.renderResult!(value, { expanded: ctx.expanded, isPartial: ctx.isPartial }, floatTheme as never, ctx).render(width);
		return [...call, ...body];
	} finally {
		setCardStyle(CARD_STYLE.NEON);
	}
}

test("float Code cards separate the heading from the first body rows exactly once", () => {
	const tool = registeredCodemode();
	const value = result([{ name: "read", status: "ok" }], "Script completed\nWall time 0.1 seconds\nOutput:\nhello");
	const collapsed = renderFloat(tool, value, context());
	const plain = collapsed.map(stripAnsi);
	for (const line of collapsed) {
		assert.equal(visibleWidth(line), 70);
		assert.ok(line.startsWith(" \x1b[48;5;22m") && line.endsWith("\x1b[49m "), JSON.stringify(line));
	}
	assert.doesNotMatch(plain.join("\n"), /[╭╮╰╯│─]/);
	assert.match(plain[0]!, /^ ▎ +$/);
	assert.match(plain[1]!, /^ ▎ λ Code /);
	assert.match(plain[2]!, /^ ▎ +$/);
	assert.match(plain[3]!, /^ ▎ ok · read/);
	assert.match(plain.at(-1)!, /^ ▎ +$/);
	assert.equal(plain.filter((line) => /^ ▎ +$/.test(line)).length, 3);

	// Expanded, the script is the first body: the separator moves above it.
	const expanded = renderFloat(tool, value, context({ expanded: true })).map(stripAnsi);
	assert.match(expanded[2]!, /^ ▎ +$/);
	assert.match(expanded[3]!, /^ ▎ await tools\.read/);
	assert.equal(expanded.filter((line) => /^ ▎ +$/.test(line)).length, 3, "no second separator above the result");

	const failed = renderFloat(tool, result([], "Script failed"), context({ isError: true }));
	for (const line of failed) assert.ok(line.startsWith(" \x1b[48;5;52m"), JSON.stringify(line));
});

// Pi builds the call component, then the result component once a result
// exists, and only then renders them: the call learns about the result at
// render time, through the row state both renderers share.
function piRow(tool: ToolDefinition, value: AgentToolResult<unknown> | undefined, ctx: ToolRenderContext, width: number, paint: object = theme): string[] {
	const call = tool.renderCall!(ctx.args, paint as never, ctx);
	const body = value ? tool.renderResult!(value, { expanded: ctx.expanded, isPartial: ctx.isPartial }, paint as never, ctx) : undefined;
	return [...call.render(width), ...(body?.render(width) ?? [])];
}

const pending = () => context({ isPartial: true, executionStarted: true, state: {} });

test("unchanged Code frames reuse paint work in both styles, widths and views", (t) => {
	const original = cardStyle();
	t.after(() => setCardStyle(original));
	const tool = decorateCodemodeTool({ name: "codemode" } as ToolDefinition);
	const output = Array.from({ length: 300 }, (_, i) => `${i}: 界🌹 e\u0301 \x1b[31mcolored\x1b[0m ${"words ".repeat(12)}`).join("\n");
	for (const style of Object.values(CARD_STYLE)) {
		setCardStyle(style);
		for (const expanded of [false, true]) {
			for (const width of [80, 160]) {
				let paints = 0;
				const painted = {
					fg: (role: string, text: string) => { paints++; return floatTheme.fg(role, text); },
					bg: (role: string, text: string) => { paints++; return floatTheme.bg(role, text); },
				};
				const ctx = context({ expanded });
				const components = [tool.renderCall!(ctx.args, painted as never, ctx),
					tool.renderResult!(result([], output), { expanded, isPartial: false }, painted as never, ctx)];
				for (const component of components) {
					const first = [...component.render(width)];
					const afterFirst = paints;
					for (let repeat = 0; repeat < 20; repeat++) assert.deepEqual(component.render(width + 0.5), first);
					assert.equal(paints, afterFirst, "unchanged frame must not repaint");
					component.invalidate();
					assert.deepEqual(component.render(width), first, "invalidation preserves exact ANSI output");
					assert.ok(paints > afterFirst);
				}
			}
		}
	}
});

test("Code cache replaces its frame on width, style and theme invalidation", (t) => {
	const original = cardStyle();
	t.after(() => setCardStyle(original));
	setCardStyle(CARD_STYLE.NEON);
	const tool = decorateCodemodeTool({ name: "codemode" } as ToolDefinition);
	let paints = 0;
	let color = "\x1b[31m";
	const painted = {
		fg: (_role: string, text: string) => { paints++; return `${color}${text}\x1b[0m`; },
		bg: floatTheme.bg,
	};
	const ctx = context();
	const value = result([], "hello 界 e\u0301\nsecond");
	const fresh = () => tool.renderResult!(value, { expanded: false, isPartial: false }, painted as never, ctx);
	const component = fresh();
	const first = [...component.render(80)];
	const before = paints;
	assert.deepEqual(component.render(80.9), first);
	assert.equal(paints, before);
	assert.deepEqual(component.render(160), fresh().render(160));
	assert.ok(paints > before);
	setCardStyle(CARD_STYLE.FLOAT);
	assert.deepEqual(component.render(160), fresh().render(160));
	setCardStyle(CARD_STYLE.NEON);
	assert.deepEqual(component.render(80), first);
	color = "\x1b[35m";
	component.invalidate();
	const changed = component.render(80);
	assert.deepEqual(changed, fresh().render(80));
	assert.notDeepEqual(changed, first);
	assert.deepEqual(changed.map(stripAnsi), first.map(stripAnsi));
	assert.deepEqual(component.render(0), []);
	assert.deepEqual(component.render(-1), []);
});

test("cached running Code calls notice result arrival and completion", (t) => {
	const original = cardStyle();
	t.after(() => setCardStyle(original));
	const tool = decorateCodemodeTool({ name: "codemode" } as ToolDefinition);
	for (const style of Object.values(CARD_STYLE)) {
		setCardStyle(style);
		for (const transition of ["result", "completion"]) {
			const ctx = pending();
			const component = tool.renderCall!(ctx.args, floatTheme as never, ctx);
			const running = [...component.render(80)];
			assert.match(running.map(stripAnsi).join("\n"), /running…/);
			assert.deepEqual(component.render(80), running);
			if (transition === "result") tool.renderResult!(result([], "partial"), { expanded: false, isPartial: true }, floatTheme as never, ctx);
			else ctx.isPartial = false;
			const changed = component.render(80);
			assert.doesNotMatch(changed.map(stripAnsi).join("\n"), /running…/);
			assert.deepEqual(changed, tool.renderCall!(ctx.args, floatTheme as never, ctx).render(80));
			assert.deepEqual(component.render(80), changed);
		}
	}
});

test("cached Code results do not leak content across partial, final or expanded components", () => {
	const tool = decorateCodemodeTool({ name: "codemode" } as ToolDefinition);
	const ctx = pending();
	const partial = tool.renderResult!(result([], "partial payload"), { expanded: false, isPartial: true }, theme as never, ctx);
	const first = [...partial.render(80)];
	assert.deepEqual(partial.render(80), first);
	const value = result([], "final payload\nsecond\nthird\nfourth detail");
	const final = tool.renderResult!(value, { expanded: false, isPartial: false }, theme as never, ctx);
	const expanded = tool.renderResult!(value, { expanded: true, isPartial: false }, theme as never, context({ expanded: true }));
	assert.match(final.render(80).join("\n"), /final payload/);
	assert.doesNotMatch(final.render(80).join("\n"), /partial payload|fourth detail/);
	assert.match(expanded.render(80).join("\n"), /fourth detail/);
	assert.deepEqual(partial.render(80), first);
});

test("a running Code card closes its own frame with one running row until a result exists", () => {
	const tool = registeredCodemode();
	const roles: string[] = [];
	const painted = { bold: (text: string) => text, fg: (role: string, text: string) => { roles.push(`${role}:${text}`); return text; } };
	const running = piRow(tool, undefined, pending(), 70, painted);
	assert.equal(running.length, 3, running.join("\n"));
	assert.match(running[0]!, /^╭─ λ Code .*╮$/);
	assert.match(running[1]!, /^│ running… +│$/);
	assert.match(running[2]!, /^╰─+╯$/);
	for (const row of running) assert.equal(visibleWidth(row), 70);
	assert.ok(roles.includes("muted:running…"), "the running row is muted");
	assert.ok(roles.includes("warning:╰"), "the running frame keeps the pending tone");
	for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
		const rows = piRow(tool, undefined, pending(), width);
		assert.ok(rows.every((row) => visibleWidth(row) <= width), `width ${width}`);
		assert.equal(rows.length, width === 0 ? 0 : 3);
	}

	// A partial result below the call closes the frame instead: one bottom rule, no running row.
	const partial = piRow(tool, result([{ name: "read", status: "running" }], "partial output"), pending(), 70);
	assert.equal(partial.filter((row) => row.startsWith("╭")).length, 1);
	assert.equal(partial.filter((row) => row.startsWith("╰")).length, 1);
	assert.match(partial.at(-1)!, /^╰─+╯$/);
	assert.doesNotMatch(partial.join("\n"), /running…/);
});

test("a finished Code card renders exactly as before the running frame existed", () => {
	const tool = registeredCodemode();
	const hint = stripAnsi(keyHint("app.tools.expand", "to expand"));
	const value = result([{ name: "read", status: "ok", durationMs: 3 }], "Script completed\nWall time 0.1 seconds\nOutput:\nhello");
	assert.deepEqual(piRow(tool, value, context({ state: {} }), 70).map(stripAnsi), [
		`╭─ λ Code ${"─".repeat(57 - hint.length)} ${hint} ╮`,
		`│ ok · read · 3ms${" ".repeat(51)} │`,
		`│ hello${" ".repeat(61)} │`,
		`╰${"─".repeat(68)}╯`,
	]);
});

test("a running float Code card is one closed panel with a single separator", () => {
	const tool = registeredCodemode();
	setCardStyle(CARD_STYLE.FLOAT);
	try {
		const running = piRow(tool, undefined, pending(), 70, floatTheme);
		const plain = running.map(stripAnsi);
		for (const line of running) assert.equal(visibleWidth(line), 70);
		assert.doesNotMatch(plain.join("\n"), /[╭╮╰╯│─]/);
		assert.equal(plain.length, 5, plain.join("\n"));
		assert.match(plain[0]!, /^ ▎ +$/);
		assert.match(plain[1]!, /^ ▎ λ Code /);
		assert.match(plain[2]!, /^ ▎ +$/);
		assert.match(plain[3]!, /^ ▎ running… +$/);
		assert.match(plain[4]!, /^ ▎ +$/);

		const partial = piRow(tool, result([{ name: "read", status: "running" }], "partial output"), pending(), 70, floatTheme).map(stripAnsi);
		assert.equal(partial.filter((line) => /^ ▎ +$/.test(line)).length, 3, "one blank above, one separator, one closing row");
		assert.doesNotMatch(partial.join("\n"), /running…/);
	} finally {
		setCardStyle(CARD_STYLE.NEON);
	}
});
