import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { NativeReviewCli, NativeReviewModeRequest, NativeReviewModeResult } from "../lib/native-review-cli.ts";

const HIDDEN = ["gentle_review_capture", "gentle_review_capture_group", "gentle_review_scope"];
const line = (mode: string, source: string) => `Receipt-driven development: ${mode} (decided by ${source})`;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

type Mode = "on" | "off";
type State = { global: Mode | ""; cloneLocal: "" | "off" };

// This is the fixture's actual native state and mutation ledger: no native
// process, settings file, consent provider, or real repository is touched.
function nativeFixture(initial: State) {
	const states = new Map<string, State>();
	const calls: Array<{ cwd: string; operation: string; scope?: unknown }> = [];
	const writes: Array<{ cwd: string; operation: string; state: State }> = [];
	const targets: string[] = [];
	const assessments: string[] = [];
	let failMutation = false;
	let failRead = false;
	let invalidRead = false;
	let hold: ReturnType<typeof deferred<NativeReviewModeResult>> | undefined;
	let started: ReturnType<typeof deferred<void>> | undefined;
	const state = (cwd: string) => {
		if (!states.has(cwd)) states.set(cwd, { ...initial });
		return states.get(cwd)!;
	};
	const result = (cwd: string, operation: NativeReviewModeRequest["operation"]): NativeReviewModeResult => {
		const value = state(cwd);
		const source = value.cloneLocal === "off" ? "clone_local" : value.global ? "global" : "default";
		const effective = value.cloneLocal === "off" ? "off" : value.global || "on";
		return { operation, scope: "clone", status: { ...value, effective, source } };
	};
	const cli = {
		async reviewMode(request: NativeReviewModeRequest) {
			const { cwd, operation } = request;
			calls.push({ cwd, operation, ...("scope" in request ? { scope: request.scope } : {}) });
			if (operation === "status") {
				const snapshot = result(cwd, operation);
				if (hold) { const waiting = hold; hold = undefined; started!.resolve(); return waiting.promise; }
				if (failRead) throw new Error("fixture status unavailable");
				if (invalidRead) return { ...snapshot, status: { ...snapshot.status, source: "invalid" } } as unknown as NativeReviewModeResult;
				return snapshot;
			}
			if (failMutation) throw new Error("fixture mutation refused");
			const current = state(cwd);
			current.cloneLocal = operation === "disable" ? "off" : "";
			writes.push({ cwd, operation, state: { ...current } });
			return result(cwd, operation);
		},
		async assess({ cwd }: { cwd: string }) {
			assessments.push(cwd);
			return { schema: "gentle-ai.review-assessment/v1", risk: "medium", reasons: [], changedPaths: 1, changedLines: 1, candidate: { kind: "current-changes" } };
		},
		async targetStatus({ cwd }: { cwd: string }) { targets.push(cwd); throw new Error("fixture target unavailable"); },
	} as unknown as NativeReviewCli;
	return {
		cli, calls, writes, targets, assessments, state, result,
		failMutation(value: boolean) { failMutation = value; },
		failRead(value: boolean) { failRead = value; },
		invalidRead(value: boolean) { invalidRead = value; },
		holdNext() { hold = deferred<NativeReviewModeResult>(); started = deferred<void>(); return { read: hold, started: started.promise }; },
	};
}

type FixtureNative = ReturnType<typeof nativeFixture>;

async function fixture(t: { after(fn: () => Promise<void>): void }, initial: State) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-rdd-mode-cache-")));
	const profile = join(root, "profile");
	mkdirSync(profile);
	const bindings = { PI_CODING_AGENT_DIR: profile, PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), GENTLE_PI_AGENT_HOME: profile, GENTLE_PI_CONFIG_HOME: join(root, "config") };
	const previous = Object.fromEntries(Object.keys(bindings).map((key) => [key, process.env[key]]));
	Object.assign(process.env, bindings);
	const live: Array<() => Promise<void>> = [];
	let clearMemo: (() => void) | undefined;
	t.after(async () => {
		try {
			for (const close of live) await close();
		} finally {
			clearMemo?.();
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
	const sdk = await import("@earendil-works/pi-coding-agent");
	const ai = await import("@earendil-works/pi-ai");
	const { createGentleAiExtension, __testing } = await import("../extensions/gentle-ai.ts");
	clearMemo = __testing.clearRddStatusMemoForTesting;
	clearMemo();
	const native = nativeFixture(initial);
	const repo = (name: string) => {
		const cwd = join(root, name);
		mkdirSync(cwd);
		const config = join(root, "gitconfig");
		writeFileSync(config, "");
		execFileSync("git", ["init", "--initial-branch=fixture"], { cwd, env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config }, stdio: "ignore" });
		return cwd;
	};
	let number = 0;
	async function host(cwd: string, nativeCli: NativeReviewCli | null = native.cli) {
		const id = ++number;
		const notices: Array<{ message: string; type?: string }> = [];
		const errors: string[] = [];
		const requests: Array<{ system: string; tools: string[] }> = [];
		const shutdown: Array<() => Promise<void>> = [];
		const tools = new Map<string, { execute(...args: any[]): Promise<any> }>();
		let ctx: ExtensionContext | undefined;
		const ui = new Proxy({ notify: (message: string, type?: string) => notices.push({ message, type }) }, {
			get(target, key) { return key in target ? Reflect.get(target, key) : () => undefined; },
		}) as unknown as ExtensionUIContext;
		const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", packages: [] });
		const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, `models-${id}.json`), refreshOnCreate: false, allowModelNetwork: false });
		const provider = `rdd-fixture-${id}`;
		const model = { id: "driver", name: "Fixture driver", provider, api: provider, baseUrl: "http://invalid.local", reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;
		const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: profile, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi) => {
				pi.on("session_start", (_event, context) => { ctx = context; });
				const capture = new Proxy(pi, { get(target, key) {
					if (key === "registerTool") return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
						tools.set(tool.name, tool);
						return target.registerTool(tool);
					};
					if (key !== "on") return Reflect.get(target, key);
					const on: ExtensionAPI["on"] = (event, handler) => {
						if (event === "session_shutdown") shutdown.push(async () => { assert.ok(ctx); await handler({ type: "session_shutdown" }, ctx); });
						return target.on(event, handler);
					};
					return on;
				} });
				createGentleAiExtension({ nativeReviewCli: nativeCli, candidateViews: null, processEnv: { ...bindings, GENTLE_AI_TELEMETRY: "0" }, resolveTelemetryTriggerBinary: () => { throw new Error("fixture"); } })(capture);
				pi.registerProvider(provider, { api: provider, apiKey: "fixture-only", baseUrl: "http://invalid.local", models: [{ id: model.id, name: model.name, reasoning: false, input: ["text"], cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
					streamSimple(_model, context) {
						requests.push({ system: ai.getCurrentSystemPrompt(context.messages), tools: ai.getCurrentTools(context.messages).map((tool) => tool.name) });
						const stream = ai.createAssistantMessageEventStream();
						const message: AssistantMessage = { role: "assistant", api: model.api, provider, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
						queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(); });
						return stream;
					},
				});
			}],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await sdk.createAgentSession({ cwd, agentDir: profile, modelRuntime: runtime, model: model as never, thinkingLevel: "off", resourceLoader: loader, tools: ["read", "gentle_review", ...HIDDEN], sessionManager: sdk.SessionManager.inMemory(cwd), settingsManager: settings });
		let closed = false;
		const close = async () => {
			if (closed) return;
			closed = true;
			await session.abort();
			// SDK dispose does not emit session_shutdown; dispatch the actual
			// registered production handlers with their SDK-provided context.
			for (const handler of shutdown) await handler();
			session.dispose();
		};
		live.push(close);
		await session.bindExtensions({ mode: "rpc", uiContext: ui, onError: (error) => errors.push(error.error) });
		return {
			session, notices, requests, errors, close,
			prompt: (text: string) => session.prompt(text, { source: "interactive" }),
			assess: () => {
				assert.ok(ctx);
				return tools.get("gentle_review")!.execute("mode-race", { operation: "assess" }, undefined, undefined, ctx);
			},
		};
	}
	return { root, repo, host, native };
}

function assertPrompt(host: { requests: Array<{ system: string; tools: string[] }> }, expected: "on" | "off" | "unknown", source?: string) {
	const request = host.requests.at(-1)!;
	assert.ok(request);
	const expectedLine = expected === "unknown" ? "Receipt-driven development: unknown (native status unavailable)" : line(expected, source!);
	assert.ok(request.system.includes(expectedLine), `expected ${expectedLine}; got ${request.system.match(/Receipt-driven development: [^\n]+/)?.[0]}`);
	assert.equal(request.system.includes("RDD off does not require an assessment"), expected === "off");
	assert.equal(request.system.includes("named Task Size high-risk item still requires one independent verifier"), expected === "off");
	for (const name of HIDDEN) assert.equal(request.tools.includes(name), expected !== "off", name);
}

test("registered mode command refreshes pinned on/off/source and preserves clone-default reporting", { timeout: 30_000 }, async (t) => {
	const f = await fixture(t, { global: "on", cloneLocal: "" });
	const cwd = f.repo("repo");
	const host = await f.host(cwd);
	await host.prompt("Initial request");
	assertPrompt(host, "on", "global");
	await host.prompt("/gentle:review-mode disable");
	assert.deepEqual(host.notices.at(-1), { message: "receipt-driven development: off (decided by clone_local)", type: "info" });
	await host.prompt("After disable");
	assertPrompt(host, "off", "clone_local");
	await host.prompt("/gentle:review-mode enable");
	assert.deepEqual(host.notices.at(-1), { message: "receipt-driven development: on (decided by global)", type: "info" });
	await host.prompt("After enable");
	assertPrompt(host, "on", "global");
	f.native.state(cwd).global = "";
	await host.prompt("/gentle:review-mode enable");
	assert.deepEqual(host.notices.at(-1), { message: "receipt-driven development: on (decided by default)", type: "info" });
	await host.prompt("After source change");
	assertPrompt(host, "on", "default");
	await host.prompt("/gentle:review-mode status");
	assert.deepEqual(host.notices.at(-1), { message: "receipt-driven development: on (decided by default)", type: "info" });
	assert.deepEqual(f.native.writes.map(({ operation }) => operation), ["disable", "enable", "enable"]);
	for (const call of f.native.calls) assert.equal(call.scope, undefined, "legacy command does not request a global scope");
	assert.deepEqual(host.errors, []);
});

test("invalid, refused and malformed reads do not grant authority or fabricate off", { timeout: 30_000 }, async (t) => {
	const f = await fixture(t, { global: "off", cloneLocal: "off" });
	const cwd = f.repo("repo");
	const host = await f.host(cwd);
	await host.prompt("Initial request");
	assertPrompt(host, "off", "clone_local");
	const calls = f.native.calls.length;
	const state = { ...f.native.state(cwd) };
	const writes = structuredClone(f.native.writes);
	await host.prompt("/gentle:review-mode invalid action");
	assert.deepEqual(host.notices.at(-1), { message: 'Unknown /gentle:review-mode sub-action "invalid action". Use status, disable, or enable.', type: "warning" });
	assert.equal(f.native.calls.length, calls);
	assert.deepEqual(f.native.state(cwd), state);
	assert.deepEqual(f.native.writes, writes);
	f.native.failMutation(true);
	await host.prompt("/gentle:review-mode enable");
	assert.deepEqual(host.notices.at(-1), { message: "fixture mutation refused", type: "error" });
	assert.deepEqual(f.native.state(cwd), state);
	assert.deepEqual(f.native.writes, writes);
	f.native.invalidRead(true);
	await host.prompt("Read after failure");
	assertPrompt(host, "unknown");
	f.native.invalidRead(false);
	await host.prompt("Freshly confirmed off");
	assertPrompt(host, "off", "clone_local");
	const beforeFreshRead = f.native.calls.filter((call) => call.operation === "status").length;
	await host.prompt("Confirm off again");
	assertPrompt(host, "off", "clone_local");
	assert.equal(f.native.calls.filter((call) => call.operation === "status").length, beforeFreshRead + 1);
	f.native.failRead(true);
	await host.prompt("Failed fresh off read");
	assertPrompt(host, "unknown");
	f.native.failRead(false);
	f.native.failMutation(false);
	await host.prompt("/gentle:review-mode enable");
	assert.deepEqual(host.notices.at(-1), { message: "receipt-driven development: off (decided by global)\nThat did not turn reviews back on: /gentle:review-mode enable only clears a clone-local override, which cannot override a global off. Run `gentle-ai review mode enable --scope=global` to turn them back on.", type: "warning" });
	assert.deepEqual(f.native.state(cwd), { global: "off", cloneLocal: "" });
	await host.prompt("Read global off");
	assertPrompt(host, "off", "global");
	assert.deepEqual(host.errors, []);
});

test("late startup status cannot resurrect on after a successful disable", { timeout: 30_000 }, async (t) => {
	const f = await fixture(t, { global: "on", cloneLocal: "" });
	const cwd = f.repo("repo");
	const pending = f.native.holdNext();
	const host = await f.host(cwd);
	await pending.started;
	await host.prompt("/gentle:review-mode disable");
	assert.deepEqual(f.native.state(cwd), { global: "on", cloneLocal: "off" });
	pending.read.resolve({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "", effective: "on", source: "global" } });
	await pending.read.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	await host.prompt("After stale startup result");
	assertPrompt(host, "off", "clone_local");
	assert.deepEqual(f.native.writes.map(({ operation }) => operation), ["disable"]);
	assert.deepEqual(f.native.targets, [], "stale on must not launch target status");
	assert.deepEqual(host.errors, []);
});

test("an unavailable mode provider cannot change native state or validate off", { timeout: 30_000 }, async (t) => {
	const f = await fixture(t, { global: "off", cloneLocal: "off" });
	const cwd = f.repo("repo");
	const state = { ...f.native.state(cwd) };
	const host = await f.host(cwd, null);
	await host.prompt("/gentle:review-mode disable");
	assert.deepEqual(host.notices.at(-1), { message: "Gentle AI review mode is not available with the currently negotiated native version.", type: "info" });
	await host.prompt("Unavailable status");
	assertPrompt(host, "unknown");
	assert.deepEqual(f.native.calls, []);
	assert.deepEqual(f.native.writes, []);
	assert.deepEqual(f.native.state(cwd), state);
	assert.deepEqual(host.errors, []);
});

test("a stale in-flight off prompt cannot undo another session's enable", { timeout: 30_000 }, async (t) => {
	const f = await fixture(t, { global: "on", cloneLocal: "off" });
	const cwd = f.repo("repo");
	const first = await f.host(cwd);
	const second = await f.host(cwd);
	await first.prompt("First session ready");
	await second.prompt("Second session ready");
	assertPrompt(first, "off", "clone_local");
	assertPrompt(second, "off", "clone_local");
	const pending = f.native.holdNext();
	const inFlight = first.prompt("Prompt awaiting the old status");
	await pending.started;
	await second.prompt("/gentle:review-mode enable");
	assert.deepEqual(second.notices.at(-1), { message: "receipt-driven development: on (decided by global)", type: "info" });
	assert.deepEqual(f.native.state(cwd), { global: "on", cloneLocal: "" });
	pending.read.resolve({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "off", effective: "off", source: "clone_local" } });
	await inFlight;
	assertPrompt(first, "unknown");
	await first.prompt("Prompt after the stale read");
	await second.prompt("Other session after enable");
	assertPrompt(first, "on", "global");
	assertPrompt(second, "on", "global");
	assert.deepEqual(f.native.writes.map(({ operation }) => operation), ["enable"]);
	assert.deepEqual([...first.errors, ...second.errors], []);
});

test("existing review-mode command protocol retains exact notifications and native requests", { timeout: 30_000 }, async (t) => {
	const f = await fixture(t, { global: "on", cloneLocal: "" });
	const cwd = f.repo("repo");
	const host = await f.host(cwd);
	await host.prompt("Warm status");
	host.notices.length = 0;
	f.native.calls.length = 0;
	for (const action of ["", " status", " disable", " status", " enable", " invalid action"]) await host.prompt(`/gentle:review-mode${action}`);
	f.native.failMutation(true);
	await host.prompt("/gentle:review-mode disable");
	f.native.failMutation(false);
	f.native.state(cwd).global = "off";
	f.native.state(cwd).cloneLocal = "off";
	await host.prompt("/gentle:review-mode enable");
	const expected = [
		{ message: "receipt-driven development: on (decided by global)", type: "info" },
		{ message: "receipt-driven development: on (decided by global)", type: "info" },
		{ message: "receipt-driven development: off (decided by clone_local)", type: "info" },
		{ message: "receipt-driven development: off (decided by clone_local)", type: "info" },
		{ message: "receipt-driven development: on (decided by global)", type: "info" },
		{ message: 'Unknown /gentle:review-mode sub-action "invalid action". Use status, disable, or enable.', type: "warning" },
		{ message: "fixture mutation refused", type: "error" },
		{ message: "receipt-driven development: off (decided by global)\nThat did not turn reviews back on: /gentle:review-mode enable only clears a clone-local override, which cannot override a global off. Run `gentle-ai review mode enable --scope=global` to turn them back on.", type: "warning" },
	];
	const calls = f.native.calls.map((call) => ({ ...call, cwd: "<fixture-cwd>" }));
	assert.deepEqual(host.notices, expected);
	assert.deepEqual(calls, ["status", "status", "disable", "status", "enable", "disable", "enable"].map((operation) => ({ cwd: "<fixture-cwd>", operation })));
	assert.deepEqual(f.native.writes.map(({ operation }) => operation), ["disable", "enable", "enable"]);
	assert.deepEqual(f.native.state(cwd), { global: "off", cloneLocal: "" });
	assert.deepEqual(host.errors, []);
	t.diagnostic(`COMMAND_DIFFERENTIAL ${JSON.stringify({ notices: host.notices, calls, writes: f.native.writes.map(({ operation, state }) => ({ operation, state })), state: f.native.state(cwd), errors: host.errors })}`);
});

test("session and workspace replacement cannot reuse an older in-flight startup result", { timeout: 30_000 }, async (t) => {
	const f = await fixture(t, { global: "on", cloneLocal: "" });
	const a = f.repo("repo-a");
	const b = f.repo("repo-b");
	const pending = f.native.holdNext();
	const old = await f.host(a);
	await pending.started;
	await old.close();
	f.native.state(a).cloneLocal = "off";
	f.native.state(b).cloneLocal = "off";
	const other = await f.host(b);
	await other.prompt("Workspace B");
	assertPrompt(other, "off", "clone_local");
	const current = await f.host(a);
	await current.prompt("New session A");
	assertPrompt(current, "off", "clone_local");
	pending.read.resolve({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "", effective: "on", source: "global" } });
	await pending.read.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	await current.prompt("A after old startup completes");
	assertPrompt(current, "off", "clone_local");
	assert.deepEqual(f.native.targets, []);
	assert.deepEqual(f.native.writes, []);
	assert.deepEqual([...old.errors, ...other.errors, ...current.errors], []);
});

test("held startup OFF cannot suppress guidance after registered enable", { timeout: 30_000 }, async (t) => {
	const f = await fixture(t, { global: "on", cloneLocal: "off" });
	const cwd = f.repo("repo");
	const pending = f.native.holdNext();
	const host = await f.host(cwd);
	await pending.started;
	await host.prompt("/gentle:review-mode enable");
	assert.deepEqual(host.notices.at(-1), { message: "receipt-driven development: on (decided by global)", type: "info" });
	pending.read.resolve({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "off", effective: "off", source: "clone_local" } });
	await pending.read.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	await host.prompt("Require current guidance");
	assertPrompt(host, "on", "global");
	const result = await host.assess();
	assert.equal(result.details.rddLine, "on");
	assert.equal(result.details.nativeRisk, "medium");
	assert.deepEqual(f.native.assessments, [cwd]);
	assert.deepEqual(f.native.targets, [cwd]);
	assert.deepEqual(f.native.writes.map(({ operation }) => operation), ["enable"]);
	assert.deepEqual(host.errors, []);
});

test("shutdown and reopen invalidate a held OFF direct assessment", { timeout: 30_000 }, async (t) => {
	const f = await fixture(t, { global: "on", cloneLocal: "off" });
	const cwd = f.repo("repo");
	const old = await f.host(cwd);
	await old.prompt("Initial OFF");
	assertPrompt(old, "off", "clone_local");
	const pending = f.native.holdNext();
	const assessment = old.assess();
	await pending.started;
	await old.close();
	const fresh = await f.host(cwd);
	await fresh.prompt("/gentle:review-mode enable");
	assert.deepEqual(fresh.notices.at(-1), { message: "receipt-driven development: on (decided by global)", type: "info" });
	pending.read.resolve({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "off", effective: "off", source: "clone_local" } });
	const result = await assessment;
	assert.equal(result.details.rddLine, "unknown");
	assert.equal(result.details.nativeRisk, "medium");
	await fresh.prompt("Reopened guidance");
	assertPrompt(fresh, "on", "global");
	assert.deepEqual(f.native.assessments, [cwd]);
	assert.deepEqual(f.native.targets, [cwd]);
	assert.deepEqual(f.native.writes.map(({ operation }) => operation), ["enable"]);
	assert.deepEqual([...old.errors, ...fresh.errors], []);
});

test("a held OFF assessment cannot skip native assessment after another session enables RDD", { timeout: 30_000 }, async (t) => {
	const f = await fixture(t, { global: "on", cloneLocal: "off" });
	const cwd = f.repo("repo");
	const first = await f.host(cwd);
	const second = await f.host(cwd);
	await first.prompt("First session ready");
	await second.prompt("Second session ready");
	const pending = f.native.holdNext();
	const inFlight = first.assess();
	await pending.started;
	await second.prompt("/gentle:review-mode enable");
	assert.deepEqual(second.notices.at(-1), { message: "receipt-driven development: on (decided by global)", type: "info" });
	assert.deepEqual(f.native.state(cwd), { global: "on", cloneLocal: "" });
	pending.read.resolve({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "off", effective: "off", source: "clone_local" } });
	const result = await inFlight;
	assert.equal(result.isError === true, false);
	assert.equal(result.details.rddLine, "unknown", "a stale OFF response is not fresh evidence");
	assert.equal(result.details.nativeRisk, "medium");
	assert.equal(result.details.plan.writerSelfVerification, true);
	assert.deepEqual(f.native.assessments, [cwd]);
	assert.deepEqual(f.native.targets, [cwd]);
	assert.deepEqual(f.native.writes.map(({ operation }) => operation), ["enable"]);
	assert.deepEqual([...first.errors, ...second.errors], []);
});
