import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage, JsonObject, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";

// With receipt-driven development off, the parent request does not require
// ASSESS and leaves the capture, capture-group, and scope declarations out.
// With RDD on, the request is exactly what the registered tools declare. Both
// paths run through a real Pi SDK session and inspect the provider request.

const HIDDEN_WHEN_OFF = ["gentle_review_capture", "gentle_review_capture_group", "gentle_review_scope"] as const;

interface RecordedRequest { systemPrompt: string; tools: Tool[] }
interface SessionRun {
	requests: RecordedRequest[];
	registered: Map<string, { description: string; promptGuidelines?: readonly string[] }>;
	assessResults: Array<{ isError: boolean; details: unknown }>;
	nativeCalls: { mode: number; assess: number; target: number };
	errors: string[];
}

type RddMode = "on" | "off" | "throws";

const NATIVE_CONTINUATION = {
	operation: "review.status",
	command: "gentle-ai review status --agent pi --next-transition",
	arguments: [{ name: "--agent", value: "pi" }, { name: "--next-transition" }],
};

function nativeCli(mode: () => RddMode, calls: SessionRun["nativeCalls"]): NativeReviewCli {
	return {
		reviewMode: async () => {
			calls.mode++;
			const effective = mode();
			if (effective === "throws") throw new Error("native review mode is unavailable");
			return { operation: "status", scope: "clone", status: { global: effective, cloneLocal: "", effective, source: "global" } };
		},
		assess: async () => {
			calls.assess++;
			return {
				schema: "gentle-ai.review-assessment/v1",
				risk: "high",
				reviewDue: true,
				reviewDueReason: "high_risk",
				nextTransition: NATIVE_CONTINUATION,
				reasons: [],
				changedPaths: 1,
				changedLines: 3,
				candidate: { kind: "current-changes", baseRef: undefined },
			};
		},
		targetStatus: async () => { calls.target++; return { applicability: "current_target", targetIdentity: "fixture" }; },
	} as unknown as NativeReviewCli;
}

async function runSession(
	root: string,
	label: string,
	bindings: Record<string, string>,
	mode: () => RddMode,
	beforeSecondPrompt: () => void = () => {},
	extra?: { tools: string[]; install: (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => void },
): Promise<SessionRun> {
	const sdk = await import("@earendil-works/pi-coding-agent");
	const ai = await import("@earendil-works/pi-ai");
	const { createGentleAiExtension } = await import("../extensions/gentle-ai.ts");
	const cwd = join(root, `repo-${label}`);
	mkdirSync(cwd);
	const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig") };
	writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "");
	// The stubbed review client needs a repository root, not a committed candidate.
	execFileSync("git", ["init", "--initial-branch=fixture"], { cwd, env: gitEnv, stdio: "ignore" });
	const run: SessionRun = { requests: [], registered: new Map(), assessResults: [], nativeCalls: { mode: 0, assess: 0, target: 0 }, errors: [] };
	let next: { name: string; arguments: JsonObject } | undefined;
	let calls = 0;
	const model = { id: "driver", name: "Local driver", provider: "loadout-fixture", api: "loadout-fixture", baseUrl: "http://invalid.local", reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;
	const manager = sdk.SessionManager.inMemory(cwd);
	const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", packages: [] });
	const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, `models-${label}.json`), refreshOnCreate: false, allowModelNetwork: false });
	const loader = new sdk.DefaultResourceLoader({
		cwd, agentDir: bindings.PI_CODING_AGENT_DIR, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi) => {
			const registerTool = pi.registerTool.bind(pi);
			pi.registerTool = ((definition: { name: string; description: string; promptGuidelines?: readonly string[] }) => {
				run.registered.set(definition.name, definition);
				return registerTool(definition as never);
			}) as typeof pi.registerTool;
			createGentleAiExtension({
				nativeReviewCli: nativeCli(mode, run.nativeCalls),
				candidateViews: null,
				processEnv: { ...bindings, GENTLE_AI_TELEMETRY: "0" },
				resolveTelemetryTriggerBinary: () => { throw new Error("fixture"); },
			})(pi);
			extra?.install(pi);
			pi.on("tool_result", (event) => {
				if (event.toolName === "gentle_review") run.assessResults.push({ isError: event.isError, details: event.details });
			});
			pi.registerProvider("loadout-fixture", {
				api: "loadout-fixture", apiKey: "fixture-only", baseUrl: "http://invalid.local",
				models: [{ id: model.id, name: model.name, reasoning: false, input: ["text"], cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
				streamSimple(_model, context) {
					run.requests.push({ systemPrompt: ai.getCurrentSystemPrompt(context.messages), tools: ai.getCurrentTools(context.messages) });
					const stream = ai.createAssistantMessageEventStream();
					const request = next;
					next = undefined;
					calls += 1;
					const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "pending" as never, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
					queueMicrotask(() => {
						stream.push({ type: "start", partial: message });
						if (request) {
							const toolCall: ToolCall = { type: "toolCall", id: `call-${calls}`, ...request };
							message.content.push(toolCall);
							stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
							stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(request.arguments), partial: message });
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
		cwd, agentDir: bindings.PI_CODING_AGENT_DIR, modelRuntime: runtime, model: model as never, thinkingLevel: "off", resourceLoader: loader,
		tools: ["read", "gentle_review", ...HIDDEN_WHEN_OFF, ...(extra?.tools ?? [])], sessionManager: manager, settingsManager: settings,
	});
	try {
		await session.bindExtensions({ mode: "json", onError: (error) => run.errors.push(error.error) });
		next = { name: "gentle_review", arguments: { operation: "assess", input: { escalate: { item: 4, reason: "Fixture process concurrency boundary" } } } };
		await session.prompt("Assess the current change.", { source: "interactive" });
		beforeSecondPrompt();
		await session.prompt("Report the plan.", { source: "interactive" });
	} finally {
		await session.abort();
		session.dispose();
	}
	return run;
}

const LEAN_GUIDELINE = /RDD off does not require an assessment/;

function fixture(t: { after: (fn: () => void) => void }): { root: string; bindings: Record<string, string> } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-review-loadout-")));
	const profile = join(root, "profile");
	mkdirSync(profile);
	const bindings = {
		PI_CODING_AGENT_DIR: profile, PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
		GENTLE_PI_AGENT_HOME: profile, GENTLE_PI_CONFIG_HOME: join(root, "config"),
	};
	const previous = Object.fromEntries(Object.keys(bindings).map((key) => [key, process.env[key]]));
	Object.assign(process.env, bindings);
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	return { root, bindings };
}

function registeredGuidelines(run: SessionRun): string[] {
	const guidelines = ["gentle_review", ...HIDDEN_WHEN_OFF].flatMap((name) => run.registered.get(name)?.promptGuidelines ?? []);
	assert.ok(guidelines.length > 0);
	return guidelines;
}

function assertLeanRequest(request: RecordedRequest, run: SessionRun): void {
	assert.match(request.systemPrompt, /Receipt-driven development: off /);
	assert.match(request.systemPrompt, LEAN_GUIDELINE);
	assert.doesNotMatch(request.systemPrompt, /after an authorized implementation, delegated or inline, call it over the diff/);
	assert.match(request.systemPrompt, /named Task Size high-risk item still requires one independent verifier/);
	assert.match(request.systemPrompt, /tests, builds, and functional checks still run/);
	for (const guideline of registeredGuidelines(run)) assert.equal(request.systemPrompt.includes(guideline), false, `RDD off must leave out: ${guideline.slice(0, 80)}`);
	const names = request.tools.map((tool) => tool.name);
	assert.ok(names.includes("gentle_review"));
	for (const hidden of HIDDEN_WHEN_OFF) assert.equal(names.includes(hidden), false, `${hidden} is not declared while RDD is off`);
	assert.doesNotMatch(request.tools.find((tool) => tool.name === "gentle_review")!.description, /gentle_review_capture/);
}

function assertRegisteredRequest(request: RecordedRequest, run: SessionRun): void {
	for (const guideline of registeredGuidelines(run)) assert.ok(request.systemPrompt.includes(guideline), `the registered loadout keeps: ${guideline.slice(0, 80)}`);
	assert.doesNotMatch(request.systemPrompt, LEAN_GUIDELINE);
	for (const name of ["gentle_review", ...HIDDEN_WHEN_OFF]) {
		const declared = request.tools.find((tool) => tool.name === name);
		assert.ok(declared, `${name} is declared`);
		assert.equal(declared.description, run.registered.get(name)?.description);
	}
}

test("RDD off: the parent request does not mandate ASSESS; RDD on keeps the registered review loadout", { timeout: 30_000 }, async (t) => {
	const { root, bindings } = fixture(t);
	const off = await runSession(root, "off", bindings, () => "off");
	const on = await runSession(root, "on", bindings, () => "on");
	assert.deepEqual(off.errors, []);
	assert.deepEqual(on.errors, []);
	assert.equal(off.requests.length >= 3, true, "assess turn, tool result turn, follow-up turn");

	for (const request of off.requests) assertLeanRequest(request, off);
	// The prefix is stable across turns of the same session.
	assert.equal(new Set(off.requests.map((request) => request.systemPrompt)).size, 1);
	assert.equal(new Set(off.requests.map((request) => JSON.stringify(request.tools))).size, 1);
	// ASSESS stays callable and returns its plan.
	assert.equal(off.assessResults.length, 1);
	assert.equal(off.assessResults[0].isError, false);
	assert.equal((off.assessResults[0].details as { schema?: string }).schema, "gentle-pi.review-assessment-plan/v1");
	const plan = off.assessResults[0].details as Record<string, unknown>;
	assert.equal(plan.rddLine, "off");
	assert.equal(plan.nativeRisk, "unassessable");
	assert.equal(plan.candidate, null);
	for (const field of ["reviewDue", "reviewDueReason", "nextTransition"]) assert.equal(Object.hasOwn(plan, field), false);
	assert.equal(off.nativeCalls.assess, 0);
	assert.equal(off.nativeCalls.target, 0);
	assert.equal((plan.plan as Record<string, unknown>).writerSelfVerification, true);
	assert.equal((plan.plan as Record<string, unknown>).independentVerifier, true);

	for (const request of on.requests) {
		assert.match(request.systemPrompt, /Receipt-driven development: on /);
		assertRegisteredRequest(request, on);
	}
	assert.equal(on.assessResults.length, 1);
	assert.equal(on.assessResults[0].isError, false);
	assert.equal(on.nativeCalls.assess, 1);
	assert.equal(on.nativeCalls.target, 1);
	assert.deepEqual((on.assessResults[0].details as Record<string, unknown>).nextTransition, NATIVE_CONTINUATION);

	const bytes = (request: RecordedRequest) => ({
		systemPrompt: Buffer.byteLength(request.systemPrompt),
		tools: Buffer.byteLength(JSON.stringify(request.tools)),
	});
	t.diagnostic(`RDD off request bytes: ${JSON.stringify(bytes(off.requests[0]))}`);
	t.diagnostic(`RDD on request bytes: ${JSON.stringify(bytes(on.requests[0]))}`);
});

test("an unknown RDD line keeps the registered loadout; turning RDD on mid-session restores it at the next run", { timeout: 30_000 }, async (t) => {
	const { root, bindings } = fixture(t);
	const { __testing } = await import("../extensions/gentle-ai.ts");
	__testing.clearRddStatusMemoForTesting();
	t.after(() => __testing.clearRddStatusMemoForTesting());

	const unknown = await runSession(root, "unknown", bindings, () => "throws");
	assert.deepEqual(unknown.errors, []);
	for (const request of unknown.requests) {
		assert.match(request.systemPrompt, /Receipt-driven development: unknown/);
		assertRegisteredRequest(request, unknown);
	}
	assert.equal(unknown.nativeCalls.assess, 1);
	assert.equal(unknown.nativeCalls.target, 1);

	let mode: RddMode = "off";
	const flipped = await runSession(root, "flip", bindings, () => mode, () => { mode = "on"; });
	assert.deepEqual(flipped.errors, []);
	const last = flipped.requests.at(-1)!;
	for (const request of flipped.requests.slice(0, -1)) assertLeanRequest(request, flipped);
	assert.match(last.systemPrompt, /Receipt-driven development: on /);
	assertRegisteredRequest(last, flipped);

	mode = "off";
	const failed = await runSession(root, "failed-after-off", bindings, () => mode, () => { mode = "throws"; });
	assert.deepEqual(failed.errors, []);
	assert.match(failed.requests.at(-1)!.systemPrompt, /Receipt-driven development: unknown/);
	assertRegisteredRequest(failed.requests.at(-1)!, failed);
});

test("malformed fresh reads restore guidance while on and unknown preserve pinning", { timeout: 30_000 }, async (t) => {
	const { root, bindings } = fixture(t);
	for (const [initial, next, expected] of [["off", "malformed", "unknown"], ["on", "throws", "on"], ["throws", "on", "unknown"]] as const) {
		let mode: RddMode = initial;
		const run = await runSession(root, `independent-${initial}`, bindings, () => mode, () => { mode = next as RddMode; });
		assert.deepEqual(run.errors, []);
		assert.match(run.requests.at(-1)!.systemPrompt, new RegExp(`Receipt-driven development: ${expected}`));
		assertRegisteredRequest(run.requests.at(-1)!, run);
		if (initial === "off") {
			assertLeanRequest(run.requests[0], run);
			assert.equal(run.nativeCalls.assess, 0);
			assert.equal(run.nativeCalls.target, 0);
		} else {
			assert.equal(run.nativeCalls.assess, 1);
			assert.equal(run.nativeCalls.target, 1);
			assert.equal(new Set(run.requests.map((request) => request.systemPrompt)).size, 1);
		}
		t.diagnostic(JSON.stringify({ initial, next, expected, requests: run.requests.length, calls: run.nativeCalls, errors: run.errors }));
	}
});

// P3 (tools by mode): another tool hidden behind codemode joins the RDD-off
// projection; it never replaces it, and the request stays stable across turns.
test("RDD off: the review capture tools stay hidden beside a tool hidden behind codemode", { timeout: 30_000 }, async (t) => {
	const { root, bindings } = fixture(t);
	const { default: gentleGuide } = await import("../extensions/gentle-guide.ts");
	const { registerCompactCodemode } = await import("../lib/codemode-renderer.ts");
	const extra = { tools: ["gentle_guide", "codemode"], install: (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => { gentleGuide(pi, {}); registerCompactCodemode(pi); } };
	const off = await runSession(root, "off-codemode", bindings, () => "off", () => {}, extra);
	assert.deepEqual(off.errors, []);
	for (const request of off.requests) {
		assertLeanRequest(request, off);
		const names = request.tools.map((tool) => tool.name);
		assert.deepEqual(names, ["read", "gentle_review", "codemode"], "review capture tools and the guide are all left out");
	}
	assert.equal(new Set(off.requests.map((request) => JSON.stringify(request.tools.map((tool) => tool.name)))).size, 1);
	const on = await runSession(root, "on-codemode", bindings, () => "on", () => {}, extra);
	assert.deepEqual(on.errors, []);
	for (const request of on.requests) assert.deepEqual(request.tools.map((tool) => tool.name), ["read", "gentle_review", ...HIDDEN_WHEN_OFF, "codemode"], "RDD on declares the review family; the guide stays behind codemode");
});
