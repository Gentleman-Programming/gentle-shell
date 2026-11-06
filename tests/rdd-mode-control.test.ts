import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createGentleAiExtension, __testing } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli, NativeReviewModeRequest, NativeReviewModeResult } from "../lib/native-review-cli.ts";
import { discoverRddModeControl } from "../lib/rdd-mode-control.ts";

const OPTIONS = ["Enable RDD for this repository", "Disable RDD for this repository", "Enable RDD machine-wide", "Disable RDD machine-wide"];
const CHANNEL = "gentle:rdd:host-ui";
type Handler = (event: any, context: any) => any;
type Mode = "" | "on" | "off";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function fixture(t: TestContext, initial: Mode = "on") {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-rdd-selector-")));
	const home = join(root, "home");
	const config = join(root, "config");
	mkdirSync(home); mkdirSync(config);
	const env = { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, "xdg"), PI_CODING_AGENT_DIR: home, GENTLE_PI_AGENT_HOME: home, GENTLE_PI_CONFIG_HOME: config, GENTLE_AI_TELEMETRY: "0" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	__testing.clearRddStatusMemoForTesting();
	t.after(() => {
		__testing.clearRddStatusMemoForTesting();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	let global: Mode = initial;
	const clones = new Map<string, Mode>();
	const calls: Array<{ cwd: string; operation: string; scope?: string }> = [];
	const writes: Array<{ cwd: string; operation: string; scope?: string }> = [];
	const assesses: string[] = [];
	const targets: string[] = [];
	let failure: "read" | "write" | "malformed" | undefined;
	let held: ReturnType<typeof deferred<NativeReviewModeResult>> | undefined;
	let started: ReturnType<typeof deferred<void>> | undefined;
	let heldWrite: ReturnType<typeof deferred<NativeReviewModeResult>> | undefined;
	let writeStarted: ReturnType<typeof deferred<void>> | undefined;
	const status = (cwd: string) => {
		const cloneLocal = clones.get(cwd) ?? "";
		const source = cloneLocal === "off" ? "clone_local" : global ? "global" : "default";
		return { global, cloneLocal, effective: cloneLocal === "off" ? "off" : global || "on", source } as NativeReviewModeResult["status"];
	};
	const native = {
		async reviewMode(request: NativeReviewModeRequest) {
			const call = { cwd: request.cwd, operation: request.operation, ...(request.scope ? { scope: request.scope } : {}) };
			calls.push(call);
			if (request.operation === "status") {
				if (held) { const next = held; held = undefined; started!.resolve(); return next.promise; }
				if (failure === "read") throw new Error("fixture status failed");
				const current = status(request.cwd);
				if (failure === "malformed") return { operation: "status", scope: "clone", status: { ...current, source: "invalid" } } as unknown as NativeReviewModeResult;
				return { operation: "status", scope: "clone", status: current } as NativeReviewModeResult;
			}
			if (failure === "write") throw new Error("fixture write refused");
			if (request.scope === "global") global = request.operation === "enable" ? "on" : "off";
			else clones.set(request.cwd, request.operation === "disable" ? "off" : "");
			writes.push(call);
			const result = { operation: request.operation, scope: request.scope ?? "clone", status: status(request.cwd) } as NativeReviewModeResult;
			if (heldWrite) { const next = heldWrite; heldWrite = undefined; writeStarted!.resolve(); return next.promise; }
			return result;
		},
		async assess({ cwd }: { cwd: string }) {
			assesses.push(cwd);
			return { schema: "gentle-ai.review-assessment/v1", risk: "medium", reasons: [], changedPaths: 1, changedLines: 1, candidate: { kind: "current-changes" } };
		},
		async targetStatus({ cwd }: { cwd: string }) { targets.push(cwd); throw new Error("fixture target unavailable"); },
	} as unknown as NativeReviewCli;
	let serial = 0;
	function host(options: { child?: boolean; unavailable?: boolean; mode?: string; hasUI?: boolean } = {}) {
		const cwd = join(root, `workspace-${++serial}`); mkdirSync(cwd);
		let id = `session-${serial}`, managerCwd = cwd;
		const handlers = new Map<string, Handler[]>();
		const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
		const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
		const bus = new Map<string, Array<(payload: unknown) => void>>();
		const notices: Array<{ message: string; type?: string }> = [];
		const prompts: Array<{ title: string; options: string[] }> = [];
		let confirmations = 0;
		let select = async (_title: string, _options: string[]): Promise<string | undefined> => undefined;
		const manager = { getSessionId: () => id, getCwd: () => managerCwd, getEntries: () => [], getBranch: () => [] };
		const ui = new Proxy({
			notify: (message: string, type?: string) => notices.push({ message, type }),
			confirm: async () => { confirmations++; return false; },
			select: async (title: string, choices: string[]) => { prompts.push({ title, options: choices }); return select(title, choices); },
		}, { get(target, key) { return key in target ? Reflect.get(target, key) : () => undefined; } });
		const ctx = { cwd, mode: options.mode ?? "tui", hasUI: options.hasUI ?? true, ui, sessionManager: manager } as unknown as ExtensionContext;
		const pi = {
			on(name: string, handler: Handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
			events: {
				on(name: string, handler: (payload: unknown) => void) { bus.set(name, [...bus.get(name) ?? [], handler]); },
				emit(name: string, payload: unknown) { for (const handler of bus.get(name) ?? []) handler(payload); },
			},
			registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
			registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.set(tool.name, tool); },
			registerMessageRenderer() {}, appendEntry() {}, getActiveTools: () => [], getThinkingLevel: () => "off",
		} as unknown as ExtensionAPI;
		createGentleAiExtension({ nativeReviewCli: options.unavailable ? null : native, candidateViews: null, processEnv: { ...env, GENTLE_PI_AGENTS_CHILD: options.child ? "1" : "0" }, resolveTelemetryTriggerBinary: () => { throw new Error("disabled"); } })(pi);
		const emit = async (name: string, event: unknown = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
		return {
			cwd, ctx, manager, ui, notices, prompts, commands, tools, pi, emit,
			start: () => emit("session_start", { type: "session_start", reason: "startup" }),
			command: async (name: string, args = "") => { const command = commands.get(name); assert.ok(command, `/${name} is registered`); await command.handler(args, ctx); },
			select: (fn: typeof select) => { select = fn; },
			setId: (value: string) => { id = value; },
			setManagerCwd: (value: string) => { managerCwd = value; },
			confirmations: () => confirmations,
		};
	}
	return {
		host, native, calls, writes, assesses, targets, status,
		state: () => ({ global, clones: [...clones] }),
		fail: (value: typeof failure) => { failure = value; },
		hold: () => { held = deferred<NativeReviewModeResult>(); started = deferred<void>(); return { read: held, started: started.promise }; },
		holdWrite: () => { heldWrite = deferred<NativeReviewModeResult>(); writeStarted = deferred<void>(); return { write: heldWrite, started: writeStarted.promise }; },
	};
}

const report = (mode: string, source: string) => ({ message: `receipt-driven development: ${mode} (decided by ${source})`, type: "info" });

test("registered selector displays effective source and applies only explicit repository choices", async (t) => {
	const f = fixture(t); const h = f.host(); await h.start();
	h.select(async () => OPTIONS[1]);
	await h.command("gentle:rdd");
	assert.deepEqual(h.prompts, [{ title: "Receipt-driven development: on (decided by global)", options: OPTIONS }]);
	assert.deepEqual(h.notices.at(-1), report("off", "clone_local"));
	assert.deepEqual(f.writes, [{ cwd: h.cwd, operation: "disable" }]);
	h.select(async () => OPTIONS[0]);
	await h.command("gentle:rdd");
	assert.deepEqual(h.notices.at(-1), report("on", "global"));
	assert.deepEqual(f.writes, [{ cwd: h.cwd, operation: "disable" }, { cwd: h.cwd, operation: "enable" }]);
	assert.deepEqual(f.calls.map(({ operation }) => operation), ["status", "disable", "status", "enable"]);
});

test("machine-wide changes require the exact named menu choice and retain clone precedence", async (t) => {
	const f = fixture(t, "off"); const h = f.host(); await h.start();
	h.select(async () => OPTIONS[0]); await h.command("gentle:rdd");
	assert.deepEqual(h.notices.at(-1), { message: "receipt-driven development: off (decided by global)\nThe repository setting cannot override machine-wide RDD off.", type: "warning" });
	h.select(async () => OPTIONS[2]); await h.command("gentle:rdd");
	assert.deepEqual(h.notices.at(-1), report("on", "global"));
	h.select(async () => OPTIONS[1]); await h.command("gentle:rdd");
	h.select(async () => OPTIONS[3]); await h.command("gentle:rdd");
	h.select(async () => OPTIONS[2]); await h.command("gentle:rdd");
	assert.deepEqual(h.notices.at(-1), { message: "receipt-driven development: off (decided by clone_local)\nThe repository override still keeps RDD off.", type: "warning" });
	assert.deepEqual(f.writes, [
		{ cwd: h.cwd, operation: "enable" }, { cwd: h.cwd, operation: "enable", scope: "global" },
		{ cwd: h.cwd, operation: "disable" }, { cwd: h.cwd, operation: "disable", scope: "global" },
		{ cwd: h.cwd, operation: "enable", scope: "global" },
	]);
});

test("RDD choices do not grant review consent or alter permission modes", async (t) => {
	const f = fixture(t); const h = f.host(); await h.start();
	await h.command("gentle:mode", "status"); const permission = h.notices.at(-1);
	await h.command("gentle:review-session-permission", "status"); const consent = h.notices.at(-1);
	h.select(async () => OPTIONS[3]); await h.command("gentle:rdd");
	assert.deepEqual(h.notices.at(-1), report("off", "global"));
	await h.command("gentle:mode", "status"); assert.deepEqual(h.notices.at(-1), permission);
	await h.command("gentle:review-session-permission", "status"); assert.deepEqual(h.notices.at(-1), consent);
	assert.equal(h.confirmations(), 0);
	assert.deepEqual(f.writes, [{ cwd: h.cwd, operation: "disable", scope: "global" }]);
	assert.deepEqual(f.assesses, []); assert.deepEqual(f.targets, []);
});

test("cancellation and forged options or arguments leave mode and counters unchanged", async (t) => {
	const f = fixture(t); const h = f.host(); await h.start();
	const state = f.state();
	await h.command("gentle:rdd");
	assert.deepEqual(h.notices, []); assert.deepEqual(f.writes, []); assert.deepEqual(f.state(), state);
	assert.deepEqual(f.calls, [{ cwd: h.cwd, operation: "status" }]);
	h.select(async () => "enable"); await h.command("gentle:rdd");
	assert.deepEqual(h.notices.at(-1), { message: "RDD unchanged: unrecognized selection.", type: "warning" });
	const count = f.calls.length;
	await h.command("gentle:rdd", "enable --global");
	assert.deepEqual(h.notices.at(-1), { message: "Use /gentle:rdd without arguments to open the interactive selector. RDD unchanged.", type: "warning" });
	assert.equal(f.calls.length, count); assert.deepEqual(f.writes, []); assert.deepEqual(f.state(), state);
});

test("provider failures and invalid status do not write or retry", async (t) => {
	const f = fixture(t); const h = f.host(); await h.start(); const state = f.state();
	f.fail("read"); await h.command("gentle:rdd");
	assert.deepEqual(h.notices.at(-1), { message: "fixture status failed", type: "error" });
	f.fail("malformed"); await h.command("gentle:rdd");
	assert.deepEqual(h.notices.at(-1), { message: "Gentle AI review mode returned an invalid status; RDD unchanged.", type: "error" });
	f.fail("write"); h.select(async () => OPTIONS[3]); await h.command("gentle:rdd");
	assert.deepEqual(h.notices.at(-1), { message: "fixture write refused", type: "error" });
	assert.deepEqual(f.calls.map(({ operation }) => operation), ["status", "status", "status", "disable"]);
	assert.equal(h.prompts.length, 1); assert.deepEqual(f.writes, []); assert.deepEqual(f.state(), state);
});

test("unavailable, headless and child hosts do not open or mutate", async (t) => {
	const f = fixture(t);
	for (const options of [{ unavailable: true }, { mode: "print", hasUI: false }, { mode: "rpc", child: true }]) {
		const h = f.host(options); await h.start(); const calls = f.calls.length; const state = f.state();
		h.select(async () => OPTIONS[3]); await h.command("gentle:rdd");
		assert.equal(h.prompts.length, 0); assert.equal(f.calls.length, calls); assert.deepEqual(f.writes, []); assert.deepEqual(f.state(), state);
		assert.deepEqual(h.notices.at(-1), options.unavailable
			? { message: "Gentle AI review mode is not available with the currently negotiated native version.", type: "info" }
			: options.hasUI === false ? undefined : { message: "RDD unchanged: an interactive primary session is required.", type: "warning" });
	}
});

test("session, workspace, UI and shutdown changes reject stale selections", async (t) => {
	const f = fixture(t);
	for (const cause of ["session", "cwd", "manager-cwd", "ui", "shutdown"] as const) {
		const h = f.host(); await h.start(); const state = f.state();
		assert.ok(h.commands.has("gentle:rdd"));
		const priorCalls = f.calls.length;
		const answer = deferred<string | undefined>(); const opened = deferred<void>();
		h.select(() => { opened.resolve(); return answer.promise; });
		const action = h.command("gentle:rdd");
		await Promise.race([opened.promise, action]);
		assert.equal(h.prompts.length, 1);
		if (cause === "session") h.setId("another-session");
		if (cause === "cwd") Object.assign(h.ctx, { cwd: `${h.cwd}-other` });
		if (cause === "manager-cwd") h.setManagerCwd(`${h.cwd}-other`);
		if (cause === "ui") Object.assign(h.ctx, { ui: { ...h.ui } });
		if (cause === "shutdown") await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		answer.resolve(OPTIONS[3]); await action;
		assert.deepEqual(f.calls.slice(priorCalls), [{ cwd: h.cwd, operation: "status" }], cause);
		assert.deepEqual(f.writes, [], cause); assert.deepEqual(f.state(), state, cause); assert.deepEqual(h.notices, [], cause);
	}
});

test("shutdown during startup does not revive a stale UI owner", async (t) => {
	const f = fixture(t); const h = f.host();
	const startup = h.start();
	await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	await startup;
	h.select(async () => OPTIONS[3]); await h.command("gentle:rdd");
	assert.deepEqual(h.prompts, []); assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, []);
	assert.equal(await discoverRddModeControl(h.pi), undefined);
});

test("the bridge exposes only owner-held read and selector, never a caller UI or setter", async (t) => {
	const f = fixture(t); const h = f.host(); await h.start();
	let bridge: any;
	const fake = { hasUI: true, ui: { select: async () => OPTIONS[3] } };
	h.pi.events.emit(CHANNEL, { context: fake, respond: (value: unknown) => { bridge = value; } });
	assert.ok(bridge); assert.equal(bridge.setMode, undefined); assert.equal(bridge.toggle, undefined);
	assert.ok(await discoverRddModeControl(h.pi), "the Customize consumer can discover the owner without supplying a UI");
	assert.deepEqual(await bridge.read(), { effective: "on", source: "global" });
	h.select(async () => undefined); await bridge.open();
	assert.equal(h.prompts.length, 1); assert.deepEqual(f.writes, []);
	await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	assert.equal(await bridge.read(), undefined); await bridge.open();
	assert.equal(h.prompts.length, 1); assert.deepEqual(f.writes, []);
	const child = f.host({ child: true, mode: "rpc" }); await child.start();
	assert.equal(await discoverRddModeControl(child.pi), undefined);
	assert.deepEqual(f.writes, []);
});

test("a global change suppresses a stale selector status before the menu opens", { timeout: 30_000 }, async (t) => {
	const f = fixture(t, "off"); const first = f.host(); const second = f.host();
	await first.start(); await second.start();
	const pending = f.hold();
	const opening = first.command("gentle:rdd"); await pending.started;
	second.select(async () => OPTIONS[2]); await second.command("gentle:rdd");
	pending.read.resolve({ operation: "status", scope: "clone", status: { global: "off", cloneLocal: "", effective: "off", source: "global" } });
	await opening;
	assert.deepEqual(first.prompts, []); assert.deepEqual(first.notices, []);
	assert.deepEqual(second.notices, [report("on", "global")]);
	assert.deepEqual(f.calls, [{ cwd: first.cwd, operation: "status" }, { cwd: second.cwd, operation: "status" }, { cwd: second.cwd, operation: "enable", scope: "global" }]);
	assert.deepEqual(f.writes, [{ cwd: second.cwd, operation: "enable", scope: "global" }]);
});

test("a machine-wide change invalidates a selection already open in another cwd", { timeout: 30_000 }, async (t) => {
	const f = fixture(t); const first = f.host(); const second = f.host();
	await first.start(); await second.start();
	const answer = deferred<string | undefined>(); const opened = deferred<void>();
	first.select(() => { opened.resolve(); return answer.promise; });
	const opening = first.command("gentle:rdd");
	await Promise.race([opened.promise, opening]);
	assert.equal(first.prompts.length, 1);
	second.select(async () => OPTIONS[3]); await second.command("gentle:rdd");
	answer.resolve(OPTIONS[2]); await opening;
	assert.deepEqual(first.notices, []);
	assert.deepEqual(second.notices, [report("off", "global")]);
	assert.deepEqual(f.calls, [{ cwd: first.cwd, operation: "status" }, { cwd: second.cwd, operation: "status" }, { cwd: second.cwd, operation: "disable", scope: "global" }]);
	assert.deepEqual(f.writes, [{ cwd: second.cwd, operation: "disable", scope: "global" }]);
});

test("a later write suppresses an obsolete in-flight mutation response without retrying", { timeout: 30_000 }, async (t) => {
	const f = fixture(t); const first = f.host(); const second = f.host();
	await first.start(); await second.start();
	first.select(async () => OPTIONS[1]);
	const pending = f.holdWrite();
	const earlier = first.command("gentle:rdd"); await pending.started;
	second.select(async () => OPTIONS[3]); await second.command("gentle:rdd");
	pending.write.resolve({ operation: "disable", scope: "clone", status: { global: "on", cloneLocal: "off", effective: "off", source: "clone_local" } });
	await earlier;
	assert.deepEqual(first.notices, []);
	assert.deepEqual(second.notices, [report("off", "global")]);
	assert.deepEqual(f.writes, [{ cwd: first.cwd, operation: "disable" }, { cwd: second.cwd, operation: "disable", scope: "global" }]);
	assert.deepEqual(f.calls.map(({ operation }) => operation), ["status", "disable", "status", "disable"]);
});

test("a session change after dispatch suppresses the reply but never retries the write", { timeout: 30_000 }, async (t) => {
	const f = fixture(t); const h = f.host(); await h.start(); h.select(async () => OPTIONS[3]);
	const pending = f.holdWrite(); const action = h.command("gentle:rdd"); await pending.started;
	h.setId("replacement");
	pending.write.resolve({ operation: "disable", scope: "global", status: { global: "off", cloneLocal: "", effective: "off", source: "global" } });
	await action;
	assert.deepEqual(h.notices, []);
	assert.deepEqual(f.calls, [{ cwd: h.cwd, operation: "status" }, { cwd: h.cwd, operation: "disable", scope: "global" }]);
	assert.deepEqual(f.writes, [{ cwd: h.cwd, operation: "disable", scope: "global" }]);
});

test("global change invalidates a direct ASSESS read in a previously unseen cwd", async (t) => {
	const f = fixture(t, "off"); const owner = f.host(); const other = f.host(); await owner.start(); await other.start();
	// The existing checkout supplies a real worktree identity without creating
	// or changing Git data. The native provider remains an in-memory fixture.
	const assessmentCwd = process.cwd();
	Object.assign(other.ctx, { cwd: assessmentCwd }); other.setManagerCwd(assessmentCwd);
	assert.ok(owner.commands.has("gentle:rdd"));
	const pending = f.hold();
	const assessment = other.tools.get("gentle_review")!.execute("race", { operation: "assess" }, undefined, undefined, other.ctx);
	await pending.started;
	owner.select(async () => OPTIONS[2]); await owner.command("gentle:rdd");
	pending.read.resolve({ operation: "status", scope: "clone", status: { global: "off", cloneLocal: "", effective: "off", source: "global" } });
	const result = await assessment;
	assert.equal(result.details.rddLine, "unknown");
	assert.deepEqual(f.assesses, [assessmentCwd]); assert.deepEqual(f.targets, [assessmentCwd]);
	assert.deepEqual(f.writes, [{ cwd: owner.cwd, operation: "enable", scope: "global" }]);
});

test("SDK sessions refresh pinned prompt state across cwd after an explicit global choice", { timeout: 30_000 }, async (t) => {
	const f = fixture(t); const firstPath = f.host().cwd; const secondPath = f.host().cwd;
	const sdk = await import("@earendil-works/pi-coding-agent");
	const ai = await import("@earendil-works/pi-ai");
	let serial = 0;
	async function host(cwd: string) {
		const id = ++serial;
		const requests: string[] = [];
		const notices: Array<{ message: string; type?: string }> = [];
		let answer: string | undefined;
		const ui = new Proxy({
			notify: (message: string, type?: string) => notices.push({ message, type }),
			select: async () => answer,
		}, { get(target, key) { return key in target ? Reflect.get(target, key) : () => undefined; } });
		const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", packages: [] });
		const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(cwd, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
		const provider = `rdd-selector-${id}`;
		const model = { id: "driver", name: "Fixture driver", provider, api: provider, baseUrl: "http://invalid.local", reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;
		const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi) => {
				createGentleAiExtension({ nativeReviewCli: f.native, candidateViews: null, processEnv: { ...process.env, GENTLE_PI_AGENTS_CHILD: "0", GENTLE_AI_TELEMETRY: "0" }, resolveTelemetryTriggerBinary: () => { throw new Error("disabled"); } })(pi);
				pi.registerProvider(provider, { api: provider, apiKey: "fixture-only", baseUrl: "http://invalid.local", models: [{ id: model.id, name: model.name, reasoning: false, input: ["text"], cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
					streamSimple(_model, context) {
						requests.push(ai.getCurrentSystemPrompt(context.messages));
						const stream = ai.createAssistantMessageEventStream();
						const message: AssistantMessage = { role: "assistant", api: model.api, provider, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
						queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(); });
						return stream;
					},
				});
			}],
		});
		await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await sdk.createAgentSession({ cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime, model: model as never, thinkingLevel: "off", resourceLoader: loader, tools: ["read", "gentle_review"], sessionManager: sdk.SessionManager.inMemory(cwd), settingsManager: settings });
		const errors: string[] = [];
		await session.bindExtensions({ mode: "rpc", uiContext: ui as never, onError: (error) => errors.push(error.error) });
		return { session, requests, notices, errors, select: (value: string) => { answer = value; }, prompt: (text: string) => session.prompt(text, { source: "interactive" }) };
	}
	const first = await host(firstPath), second = await host(secondPath);
	try {
		await first.prompt("Initial A"); await second.prompt("Initial B");
		assert.match(second.requests.at(-1)!, /Receipt-driven development: on \(decided by global\)/);
		first.select(OPTIONS[3]!); await first.prompt("/gentle:rdd");
		assert.deepEqual(first.notices.at(-1), report("off", "global"));
		await second.prompt("After machine-wide off");
		assert.match(second.requests.at(-1)!, /Receipt-driven development: off \(decided by global\)/);
		assert.ok(second.requests.at(-1)!.includes("RDD off does not require an assessment"));
		first.select(OPTIONS[2]!); await first.prompt("/gentle:rdd");
		assert.deepEqual(first.notices.at(-1), report("on", "global"));
		await second.prompt("After machine-wide on");
		assert.match(second.requests.at(-1)!, /Receipt-driven development: on \(decided by global\)/);
		assert.equal(second.requests.at(-1)!.includes("RDD off does not require an assessment"), false);
		assert.deepEqual(f.writes, [{ cwd: firstPath, operation: "disable", scope: "global" }, { cwd: firstPath, operation: "enable", scope: "global" }]);
		assert.deepEqual([...first.errors, ...second.errors], []);
	} finally {
		await first.session.abort(); await second.session.abort(); first.session.dispose(); second.session.dispose();
	}
});

test("existing review-mode retains clone-default requests and exact notices", async (t) => {
	const f = fixture(t, ""); const h = f.host(); await h.start();
	await h.command("gentle:review-mode", "disable");
	assert.deepEqual(h.notices.at(-1), report("off", "clone_local"));
	await h.command("gentle:review-mode", "enable");
	assert.deepEqual(h.notices.at(-1), report("on", "default"));
	await h.command("gentle:review-mode", "status");
	assert.deepEqual(h.notices.at(-1), report("on", "default"));
	assert.deepEqual(f.calls, [{ cwd: h.cwd, operation: "disable" }, { cwd: h.cwd, operation: "enable" }, { cwd: h.cwd, operation: "status" }]);
	assert.deepEqual(f.writes, f.calls.slice(0, 2));
});
