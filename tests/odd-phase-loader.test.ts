import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "../lib/terminal-theme.ts";

initTheme("dark");

test("a child process cannot overwrite the primary process phase even with the same session id", async () => {
	const registry = (await createJiti(import.meta.url, { moduleCache: false }).import<typeof import("../lib/odd-phase.ts")>("../lib/odd-phase.ts")).oddPhaseRegistry;
	const sessionId = "process-isolation-test";
	try {
		registry.report(sessionId, "authorizing");
		const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
			`import { oddPhaseRegistry } from ${JSON.stringify(new URL("../lib/odd-phase.ts", import.meta.url).href)}; console.log(oddPhaseRegistry.get("process-isolation-test") ?? "empty"); oddPhaseRegistry.report("process-isolation-test", "closing");`], { encoding: "utf8" });
		assert.equal(output.trim(), "empty");
		assert.equal(registry.get(sessionId), "authorizing");
	} finally { registry.clear(sessionId); }
});

// Pi gives each extension its own uncached jiti loader. Exercise the actual
// writer tool and reader prompt, not two imports through Node's module cache.
test("separate extension loaders share only the active session's ODD phase and redraw", async () => {
	const aiLoader = createJiti(import.meta.url, { moduleCache: false });
	const shellLoader = createJiti(import.meta.url, { moduleCache: false });
	const { createGentleAiExtension } = await aiLoader.import<typeof import("../extensions/gentle-ai.ts")>("../extensions/gentle-ai.ts");
	const { default: shell } = await shellLoader.import<typeof import("../extensions/gentle-shell.ts")>("../extensions/gentle-shell.ts");
	const aiRegistry = (await aiLoader.import<typeof import("../lib/odd-phase.ts")>("../lib/odd-phase.ts")).oddPhaseRegistry;
	const shellRegistry = (await shellLoader.import<typeof import("../lib/odd-phase.ts")>("../lib/odd-phase.ts")).oddPhaseRegistry;
	const tools = new Map<string, {
		execute: (...args: unknown[]) => Promise<unknown>;
		renderShell?: string;
		renderCall?: (args: unknown, theme: unknown, context: unknown) => { render(width: number): string[]; invalidate(): void };
		renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => { render(width: number): string[]; invalidate(): void };
	}>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		on(name: string, fn: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) { tools.set(tool.name, tool); },
		registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, appendEntry() {},
		events: { on: () => () => {}, emit() {} },
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	};
	createGentleAiExtension({ nativeReviewCli: null } as never)(pi as never);
	shell(pi as never, {}, { resolveWorktree: (path: string) => ({ root: path, commonDir: path }), gitRunner: () => async () => ({ stdout: "", stderr: "", code: 0, killed: false }), devBinary: () => undefined } as never);
	let sessionId: string | undefined = "primary-loader-test";
	let editorFactory: ((tui: unknown, theme: unknown, bindings: unknown) => { render(width: number): string[]; setAnimationPolicy(policy: string): void; dispose(): void }) | undefined;
	let redraws = 0;
	const ui = {
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		setFooter() {}, setWidget() {}, setWorkingVisible() {}, notify() {},
		getEditorComponent: () => editorFactory,
		setEditorComponent(factory: typeof editorFactory) { editorFactory = factory; },
	};
	const ctx = {
		hasUI: true, mode: "tui", cwd: "/repo", ui,
		sessionManager: { getSessionId: () => sessionId, getEntries: () => [], getCwd: () => "/repo" },
		hasPendingMessages: () => false, isIdle: () => true,
		modelRegistry: { isUsingOAuth: () => false },
	};
	const fire = async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); };
	let editor: ReturnType<NonNullable<typeof editorFactory>> | undefined;
	try {
		await fire("session_start");
		assert.ok(editorFactory, "Gentle Shell should install its prompt");
		editor = editorFactory({ terminal: { rows: 40, columns: 120 }, requestRender() { redraws++; } }, { borderColor: (text: string) => text, selectList: {} }, { matches: () => false });
		editor.setAnimationPolicy("potato");
		await fire("agent_start");
		const render = () => stripAnsi(editor!.render(60)[0]!);
		assert.match(render(), /working…/);
		assert.ok(tools.get("gentle_odd_phase"));
		const report = (phase: string) => tools.get("gentle_odd_phase")!.execute("call", { phase }, undefined, undefined, ctx);
		redraws = 0;
		const phaseTool = tools.get("gentle_odd_phase")!;
		const successful = await report("authorizing");
		assert.equal(phaseTool.renderShell, "self", "Pi must not paint its default tool card");
		const toolTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const renderContext = (isError: boolean) => ({
			args: { phase: "authorizing" }, toolCallId: "call", invalidate() {}, lastComponent: undefined,
			state: {}, cwd: "/repo", executionStarted: true, argsComplete: true,
			isPartial: false, expanded: false, showImages: false, isError,
		});
		const renderTool = (component: { render(width: number): string[]; invalidate(): void }) => component.render(80);
		assert.ok(phaseTool.renderCall && phaseTool.renderResult);
		assert.deepEqual(renderTool(phaseTool.renderCall({ phase: "authorizing" }, toolTheme, renderContext(false))), []);
		assert.deepEqual(renderTool(phaseTool.renderResult(successful, { isPartial: false, expanded: false }, toolTheme, renderContext(false))), []);
		assert.deepEqual(renderTool(phaseTool.renderResult(successful, { isPartial: false, expanded: true }, toolTheme, renderContext(false))), []);
		assert.match(render(), /authorizing…/, "suppressing the transcript must not suppress the editor phase");
		assert.ok(redraws > 0, "the phase must request redraw even without a pulse");
		assert.equal(aiRegistry.get(sessionId), "authorizing");
		assert.equal(shellRegistry.get(sessionId), "authorizing");
		for (const [id, phase, expected] of [
			["primary-loader-test", "not-a-phase", /Invalid ODD phase/],
			[undefined, "exploring", /No active session/],
		] as const) {
			sessionId = id;
			let message = "";
			await assert.rejects(() => report(phase), (error: unknown) => {
				assert.ok(error instanceof Error);
				message = error.message;
				assert.match(message, expected);
				return true;
			});
			const failure = { content: [{ type: "text", text: message }], isError: true };
			assert.match(renderTool(phaseTool.renderResult(failure, { isPartial: false, expanded: false }, toolTheme, renderContext(true))).join("\n"), expected);
			assert.match(renderTool(phaseTool.renderResult(failure, { isPartial: false, expanded: true }, toolTheme, renderContext(true))).join("\n"), expected);
		}
		const callComponent = phaseTool.renderCall({ phase: "checking" }, toolTheme, renderContext(false));
		const resultComponent = phaseTool.renderResult(successful, { isPartial: false, expanded: false }, toolTheme, renderContext(false));
		for (const component of [callComponent, resultComponent]) {
			assert.equal(typeof component.invalidate, "function");
			component.invalidate();
			assert.deepEqual(component.render(80), []);
		}
		sessionId = "primary-loader-test";
		assert.match(render(), /authorizing…/, "a malformed report cannot erase the last valid phase");
		const cleared = await report("clear");
		assert.deepEqual(renderTool(phaseTool.renderResult(cleared, { isPartial: false, expanded: false }, toolTheme, renderContext(false))), []);
		assert.match(render(), /working…/);
		await report("authorizing");
		sessionId = "child-session";
		await report("exploring");
		assert.equal(aiRegistry.get("primary-loader-test"), "authorizing");
		sessionId = "primary-loader-test";
		assert.match(render(), /authorizing…/);
		await fire("agent_settled");
		assert.equal(aiRegistry.get(sessionId), undefined);
		await fire("agent_start");
		assert.match(render(), /working…/);
		await report("checking");
		await fire("agent_start");
		assert.match(render(), /working…/);
		await report("closing");
		await fire("session_shutdown");
		assert.equal(aiRegistry.get(sessionId), undefined);
		redraws = 0;
		await report("planning");
		assert.equal(redraws, 0, "shutdown must remove the old render callback");
	} finally {
		aiRegistry.clear("primary-loader-test");
		aiRegistry.clear("child-session");
		editor?.dispose();
	}
});

// The label follows the primary session's own tool activity without any
// gentle_odd_phase call; an explicit report still refines it.
test("tool activity in the primary session drives the working label across extension loaders", async () => {
	const aiLoader = createJiti(import.meta.url, { moduleCache: false });
	const shellLoader = createJiti(import.meta.url, { moduleCache: false });
	const { createGentleAiExtension } = await aiLoader.import<typeof import("../extensions/gentle-ai.ts")>("../extensions/gentle-ai.ts");
	const { default: shell } = await shellLoader.import<typeof import("../extensions/gentle-shell.ts")>("../extensions/gentle-shell.ts");
	const registry = (await aiLoader.import<typeof import("../lib/odd-phase.ts")>("../lib/odd-phase.ts")).oddPhaseRegistry;
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		on(name: string, fn: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
		registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) { tools.set(tool.name, tool); },
		registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, appendEntry() {},
		events: { on: () => () => {}, emit() {} },
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
	};
	createGentleAiExtension({ nativeReviewCli: null } as never)(pi as never);
	shell(pi as never, {}, { resolveWorktree: (path: string) => ({ root: path, commonDir: path }), gitRunner: () => async () => ({ stdout: "", stderr: "", code: 0, killed: false }), devBinary: () => undefined } as never);
	let sessionId = "tool-activity-loader-test";
	let redraws = 0;
	let editorFactory: ((tui: unknown, theme: unknown, bindings: unknown) => { render(width: number): string[]; setAnimationPolicy(policy: string): void; dispose(): void }) | undefined;
	const ui = {
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		setFooter() {}, setWidget() {}, setWorkingVisible() {}, notify() {},
		getEditorComponent: () => editorFactory,
		setEditorComponent(factory: typeof editorFactory) { editorFactory = factory; },
	};
	const ctx = {
		hasUI: true, mode: "tui", cwd: "/repo", ui,
		sessionManager: { getSessionId: () => sessionId, getEntries: () => [], getCwd: () => "/repo" },
		hasPendingMessages: () => false, isIdle: () => true,
		modelRegistry: { isUsingOAuth: () => false },
	};
	const fire = async (name: string, event: unknown = {}, context: unknown = ctx) => { for (const fn of handlers.get(name) ?? []) await fn(event, context); };
	const tool = (toolName: string, args: unknown = {}) => fire("tool_execution_start", { type: "tool_execution_start", toolCallId: `call-${toolName}`, toolName, args });
	let editor: ReturnType<NonNullable<typeof editorFactory>> | undefined;
	try {
		await fire("session_start");
		assert.ok(editorFactory, "Gentle Shell should install its prompt");
		editor = editorFactory({ terminal: { rows: 40, columns: 120 }, requestRender() { redraws++; } }, { borderColor: (text: string) => text, selectList: {} }, { matches: () => false });
		editor.setAnimationPolicy("potato");
		await fire("agent_start");
		const render = () => stripAnsi(editor!.render(60)[0]!);
		assert.match(render(), /working…/);

		await tool("read", { path: "lib/odd-phase.ts" });
		assert.match(render(), /exploring…/, "reading a file shows exploring");
		await tool("edit", { path: "lib/odd-phase.ts" });
		assert.match(render(), /implementing…/, "editing shows implementing");
		await tool("bash", { command: "pnpm test" });
		assert.match(render(), /checking…/, "running tests shows checking");
		await tool("ask_user_question", {});
		assert.match(render(), /deciding…/, "asking the user shows deciding");
		await tool("mcp__custom-tools__write", { path: "odd/tasks/feature.md" });
		assert.match(render(), /planning…/, "MCP-prefixed names are normalized");
		await tool("subagent_start", {});
		await tool("bash", { command: "git push" });
		await tool("unknown_tool", {});
		assert.match(render(), /planning…/, "unknown tools and ambiguous commands leave the label unchanged");
		await tool("subagent_run", { agent: "gentle-ai-worker", mode: "task", task: "implement" });
		assert.match(render(), /implementing…/, "foreground worker launch replaces stale planning");
		redraws = 0;
		await tool("read", { path: "lib/odd-phase.ts" });
		await tool("todo", {});
		await tool("write", { path: "odd/tasks/feature.md" });
		assert.match(render(), /implementing…/, "incidental reads and task bookkeeping cannot hide worker activity");
		assert.equal(redraws, 0, "ignored signals do not redraw the editor");
		await tool("subagent_run", { agent: "gentle-ai-verify", mode: "background", task: "verify" });
		assert.match(render(), /checking…/, "background verifier launch replaces active implementation");
		assert.equal(redraws, 1, "phase change redraws even under potato animation");
		await tool("read", { path: "tests/odd-phase.test.ts" });
		await tool("todo", {});
		assert.match(render(), /checking…/);
		await tool("subagent_run", { agent: "unknown", task: "gentle-ai-worker implementing" });
		assert.match(render(), /checking…/, "unknown agent prose is not evidence");
		await tool("subagent_run", { agent: "gentle-ai-explore", mode: "task" });
		assert.match(render(), /exploring…/, "later delegated exploration is a real phase transition");
		await tool("subagent_run", { agent: "gentle-ai-worker", mode: "background" });
		assert.match(render(), /implementing…/, "background worker replaces stale exploring");
		await tool("subagent_run", { agent: "gentle-ai-verify", mode: "task" });
		assert.match(render(), /checking…/, "foreground verifier replaces stale work");
		await tool("edit", { path: "lib/odd-phase.ts" });
		assert.match(render(), /implementing…/, "a subsequent source edit can restart implementation");

		await tools.get("gentle_odd_phase")!.execute("call", { phase: "researching" }, undefined, undefined, ctx);
		await tool("gentle_odd_phase", { phase: "researching" });
		await tool("grep", { pattern: "x" });
		assert.match(render(), /researching…/, "an explicit phase survives a following grep");
		await tool("edit", { path: "lib/odd-phase.ts" });
		assert.match(render(), /implementing…/, "a stronger inferred phase overrides an explicit one");

		await fire("agent_start");
		assert.match(render(), /working…/, "a new turn starts unlabeled");
		const childCtx = { ...ctx, mode: "rpc" };
		await fire("tool_execution_start", { type: "tool_execution_start", toolCallId: "child", toolName: "subagent_run", args: { agent: "gentle-ai-worker" } }, childCtx);
		assert.equal(registry.get(sessionId), undefined, "a headless RPC (subagent) process never infers a phase");
		sessionId = "other-session";
		await tool("subagent_run", { agent: "gentle-ai-verify" });
		assert.equal(registry.get("tool-activity-loader-test"), undefined, "another session cannot relabel the primary session");
		assert.equal(registry.get(sessionId), "checking");
	} finally {
		registry.clear("tool-activity-loader-test");
		registry.clear("other-session");
		editor?.dispose();
	}
});
