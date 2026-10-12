import assert from "node:assert/strict";
import test from "node:test";
import pretty from "../extensions/pi-pretty.ts";
import { setBundledInstallForTesting } from "../lib/gentle-shell-bundled.ts";

test("bundled pretty cannot replace or restore an editor owned by the host", async () => {
	const handlers = new Map<string, Function[]>();
	const pi = { on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
	const owner = () => "custom";
	let editor: unknown = owner;
	let indicator: unknown;
	let message: unknown;
	let visible = true;
	const ctx = { mode: "tui", ui: {
		getEditorComponent: () => editor,
		setEditorComponent: (value: unknown) => { editor = value; },
		setWorkingIndicator: (value: unknown) => { indicator = value; },
		setWorkingMessage: (value: unknown) => { message = value; },
		setWorkingVisible(value: boolean) { visible = value; },
		theme: { fg: (role: string, text: string) => `<${role}>${text}</${role}>`, bold: (text: string) => text },
	} };
	const previousThinkingIndicator = process.env.PRETTY_THINKING_INDICATOR;
	let thinkingIndicatorDuringActivation: string | undefined;
	await pretty(pi, undefined, async (api: any) => {
		thinkingIndicatorDuringActivation = process.env.PRETTY_THINKING_INDICATOR;
		api.on("session_start", (_event: unknown, context: any) => {
			context.ui.setEditorComponent(() => "pretty");
			context.ui.setWorkingIndicator({ frames: ["foreign"] });
		});
		api.on("session_shutdown", (_event: unknown, context: any) => context.ui.setEditorComponent(undefined));
	}, {});
	assert.equal(thinkingIndicatorDuringActivation, "off", "Gentle Shell disables pi-pretty's global Thinking shimmer");
	assert.equal(process.env.PRETTY_THINKING_INDICATOR, previousThinkingIndicator, "activation must restore the caller's environment");
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	assert.equal(editor, owner);
	assert.equal(visible, false, "the prompt frame owns the live working state without a duplicate loader row");
	assert.equal(indicator, undefined);
	assert.equal(message, undefined);
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
	assert.equal(editor, owner);
	assert.equal(visible, true);
	assert.equal(indicator, undefined);
	assert.equal(message, undefined);
});

test("bundled pretty keeps Pi's native Working row inside Herdr", async () => {
	const handlers = new Map<string, Function[]>();
	const pi = { on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
	let visible: boolean | undefined;
	const ctx = { mode: "tui", ui: { setWorkingVisible(value: boolean) { visible = value; } } };
	await pretty(pi, undefined, async () => {}, { HERDR_ENV: "1" });
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	assert.notEqual(visible, false, "Herdr's native Pi detection reads the standard Working row");
});

test("bundled pretty tolerates UI contexts lacking working indicator methods", async () => {
	const handlers = new Map<string, Function[]>();
	const pi = { on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
	const ctx = { mode: "tui", ui: {} };
	await pretty(pi, undefined, async () => {}, {});
	for (const handler of handlers.get("session_start") ?? []) {
		await assert.doesNotReject(async () => handler({}, ctx));
	}
	for (const handler of handlers.get("session_shutdown") ?? []) {
		await assert.doesNotReject(async () => handler({}, ctx));
	}
});

test("disabled shell leaves bundled editor behavior untouched", async () => {
	let received: unknown;
	const pi = {};
	await pretty(pi, undefined, async (api: unknown) => { received = api; }, { GENTLE_PI_SHELL: "0" });
	assert.equal(received, pi);
});

// gentle-shell#1690: a delegated child has no shell (shellEnabled is false),
// so the upstream fallback would start FFF indexing in every child.
test("delegated children never load upstream pi-pretty", async () => {
	let loaded = false;
	const pi = {};
	const result = await pretty(pi, undefined, async () => { loaded = true; }, { GENTLE_PI_AGENTS_CHILD: "1" });
	assert.equal(loaded, false);
	assert.equal(result, undefined);
});

// S9: outside a bundled install Pi's deps reach pi-pretty unchanged, so its
// FFF store stays where it always was ($HOME/.pi/agent, or none without HOME).
test("outside a bundled install pi-pretty gets Pi's deps unchanged", async () => {
	const given = { TextComponent: "text" };
	for (const env of [{}, { PI_CODING_AGENT_DIR: "/agent-home" }, { PI_CODING_AGENT_DIR: "/agent-home", GENTLE_PI_SHELL: "0" }, { GENTLE_SHELL_PREFIX: "/not-ours" }]) {
		for (const deps of [undefined, given]) {
			let received: unknown = "unset";
			await pretty({ on() {} }, deps, async (_api: unknown, forwarded: unknown) => { received = forwarded; }, env);
			assert.equal(received, deps, JSON.stringify(env));
		}
	}
});

// In a bundled install the FFF store follows the agent home. The testing
// overlay stands in for this package running from a prefix; the current
// folder serves as one because the prefix must exist.
test("in a bundled install pi-pretty gets the agent home and Pi's tool factories through deps.sdk", async (t) => {
	setBundledInstallForTesting({ root: process.cwd() });
	t.after(() => setBundledInstallForTesting(undefined));
	const factories = ["createReadToolDefinition", "createBashToolDefinition", "createLsToolDefinition", "createFindToolDefinition", "createGrepToolDefinition"];
	const bundledEnv = { GENTLE_SHELL_PREFIX: process.cwd(), PI_CODING_AGENT_DIR: "/agent-home" };
	for (const env of [bundledEnv, { ...bundledEnv, GENTLE_PI_SHELL: "0" }]) {
		let received: any;
		await pretty({ on() {} }, { TextComponent: "text" }, async (_api: unknown, deps: unknown) => { received = deps; }, env);
		assert.equal(received.TextComponent, "text", "the host's other deps are kept");
		assert.equal(received.sdk.getAgentDir(), "/agent-home");
		for (const name of factories) assert.equal(typeof received.sdk[name], "function", name);
	}
	// A host that already passes its own sdk keeps it.
	const sdk = { getAgentDir: () => "/host" };
	let kept: any;
	await pretty({ on() {} }, { sdk }, async (_api: unknown, deps: unknown) => { kept = deps; }, bundledEnv);
	assert.equal(kept.sdk, sdk);
});
