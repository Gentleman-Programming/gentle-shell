import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage, JsonObject, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";

// gentle-pi S11 T1: with receipt-driven development off, the orchestrator only
// ever calls gentle_review ASSESS, so the parent request carries a short ASSESS
// guideline and leaves the capture, capture-group, and scope declarations out.
// With RDD on, the request is exactly what the registered tools declare. Both
// paths run through a real Pi SDK session and inspect the provider request.

const HIDDEN_WHEN_OFF = ["gentle_review_capture", "gentle_review_capture_group", "gentle_review_scope"] as const;

interface RecordedRequest { systemPrompt: string; tools: Tool[] }
interface SessionRun {
	requests: RecordedRequest[];
	registered: Map<string, { description: string; promptGuidelines?: readonly string[] }>;
	assessResults: Array<{ isError: boolean; details: unknown }>;
	errors: string[];
}

type RddMode = "on" | "off" | "throws";

const NATIVE_CONTINUATION = {
	operation: "review.status",
	command: "gentle-ai review status --agent pi --next-transition",
	arguments: [{ name: "--agent", value: "pi" }, { name: "--next-transition" }],
};

function nativeCli(mode: () => RddMode): NativeReviewCli {
	return {
		reviewMode: async () => {
			const effective = mode();
			if (effective === "throws") throw new Error("native review mode is unavailable");
			return { operation: "status", scope: "clone", status: { global: effective, cloneLocal: "", effective, source: "global" } };
		},
		assess: async () => ({
			schema: "gentle-ai.review-assessment/v1",
			risk: "high",
			reviewDue: true,
			reviewDueReason: "high_risk",
			nextTransition: NATIVE_CONTINUATION,
			reasons: [],
			changedPaths: 1,
			changedLines: 3,
			candidate: { kind: "current-changes", baseRef: undefined },
		}),
	} as unknown as NativeReviewCli;
}

async function runSession(
	root: string,
	label: string,
	bindings: Record<string, string>,
	mode: () => RddMode,
	beforeSecondPrompt: () => void = () => {},
): Promise<SessionRun> {
	const sdk = await import("@earendil-works/pi-coding-agent");
	const ai = await import("@earendil-works/pi-ai");
	const { createGentleAiExtension } = await import("../extensions/gentle-ai.ts");
	const cwd = join(root, `repo-${label}`);
	mkdirSync(cwd);
	const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig") };
	writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "");
	execFileSync("git", ["init", "--initial-branch=fixture"], { cwd, env: gitEnv, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=SDK Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"], { cwd, env: gitEnv, stdio: "ignore" });
	const run: SessionRun = { requests: [], registered: new Map(), assessResults: [], errors: [] };
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
				nativeReviewCli: nativeCli(mode),
				candidateViews: null,
				processEnv: { ...bindings, GENTLE_AI_TELEMETRY: "0" },
				resolveTelemetryTriggerBinary: () => { throw new Error("fixture"); },
			})(pi);
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
		tools: ["read", "gentle_review", ...HIDDEN_WHEN_OFF], sessionManager: manager, settingsManager: settings,
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

const LEAN_GUIDELINE = /gentle_review only for \{"operation":"assess"\}/;

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
	assert.match(request.systemPrompt, /relay it unchanged but do not execute it while RDD is off/);
	assert.match(request.systemPrompt, /assessment metadata does not authorize STATUS, another review lifecycle operation, or enabling RDD/);
	assert.doesNotMatch(request.systemPrompt, /relay it unchanged and follow it/);
	assert.match(request.systemPrompt, /Continue the returned verification plan/);
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

test("RDD off: the parent request carries only the lean ASSESS loadout; RDD on: the registered review loadout", { timeout: 30_000 }, async (t) => {
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
	assert.equal(plan.reviewDue, true);
	assert.equal(plan.reviewDueReason, "high_risk");
	assert.deepEqual(plan.nextTransition, NATIVE_CONTINUATION);
	assert.equal((plan.plan as Record<string, unknown>).writerSelfVerification, true);
	assert.equal((plan.plan as Record<string, unknown>).independentVerifier, true);

	for (const request of on.requests) {
		assert.match(request.systemPrompt, /Receipt-driven development: on /);
		assertRegisteredRequest(request, on);
	}
	assert.equal(on.assessResults.length, 1);
	assert.equal(on.assessResults[0].isError, false);

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

	let mode: RddMode = "off";
	const flipped = await runSession(root, "flip", bindings, () => mode, () => {
		mode = "on";
		__testing.clearRddStatusMemoForTesting();
	});
	assert.deepEqual(flipped.errors, []);
	const last = flipped.requests.at(-1)!;
	for (const request of flipped.requests.slice(0, -1)) assertLeanRequest(request, flipped);
	assert.match(last.systemPrompt, /Receipt-driven development: on /);
	assertRegisteredRequest(last, flipped);
});
