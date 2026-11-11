import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { AssistantMessage, Tool } from "@earendil-works/pi-ai";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import { createCoordinatorRuntime, type CoordinatorRuntimeOptions } from "./support/review-coordinator-runtime.ts";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { NativeReviewConsentRequiredError } from "../lib/native-review-cli.ts";
import { decodeReviewConsentV3 } from "../lib/review-integration-v2.ts";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import { readFileSync } from "node:fs";

// odd/tasks/review-one-call.md: one gentle_review_run call drives an ordinary
// native review to its acknowledged approval (S2-S6).

// One repository for every fixture run: the facade retains a lineage's
// workspace route for the process, and every fixture shares one lineage.
let repo: string | undefined;
after(() => { if (repo !== undefined) rmSync(repo, { recursive: true, force: true }); });
function scratchRepo(): string {
	if (repo !== undefined) return repo;
	repo = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "rdd-one-call-")));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	writeFileSync(join(repo, "candidate.ts"), "export const value = 1;\n");
	return repo;
}

async function runOnce(cwd: string, options: CoordinatorRuntimeOptions) {
	const runtime = createCoordinatorRuntime(cwd, "coordinator", options);
	try {
		const result = await runtime.invoke("gentle_review_run", { lineageId: runtime.lineage });
		return { result, displayed: runtime.forecasts.length, relayRuns: runtime.relayRuns(), closed: runtime.closed(), nativeCalls: [...runtime.nativeCalls] };
	} finally { runtime.close(); }
}

const FINDINGS = {
	statement: "Fixture advisory statement; not real review output.",
	findings: [{ id: "F1", lens: "review-risk", location: "candidate.ts:1", severity: "WARNING", disposition: "follow_up" }],
};

test("S4: without a UI one call records the reviewer-run forecast and continues to the acknowledged approval", async () => {
	const cwd = scratchRepo();
	const run = await runOnce(cwd, { hasUI: false });
	assert.equal(run.result.outcome, "closed", JSON.stringify(run.result));
	assert.ok(run.closed);
	assert.equal(run.relayRuns, 1, "exactly the forecast reviewer run");
	assert.equal(run.displayed, 0, "no UI display happens without a UI");
	assert.equal(run.result.forecasts.length, 1);
	assert.equal(run.result.forecasts[0].outcome, "reviewer-model-run-forecast");
	// The same native trace as the UI path, which still displays the forecast to the human.
	const withUI = await runOnce(cwd, { hasUI: true });
	assert.equal(withUI.result.outcome, "closed");
	assert.equal(withUI.displayed, 1);
	assert.deepEqual(run.nativeCalls, withUI.nativeCalls);
	assert.deepEqual(run.result.forecasts, withUI.result.forecasts);
	// S6: the acknowledgement keeps ordinary delivery policy.
	assert.equal(run.result.result.delivery, "ordinary-repository-policy");
	assert.equal(run.result.result.authority, "burned");
});

test("S4/S6: without a UI, RDD turned off before any facade operation stops before the next provider call and any reviewer", async () => {
	const cwd = scratchRepo();
	// Off from the 1st, 2nd or 3rd mode read, or once the forecast preflight STATUS ran.
	const triggers: [string, (read: number, calls: readonly string[]) => boolean][] = [
		...[1, 2, 3].map((k) => [`mode read ${k}`, (read: number) => read >= k] as [string, (read: number) => boolean]),
		["after the recorded forecast", (_read, calls) => calls.filter((call) => call === "status:reviewing").length >= 2],
	];
	for (const [label, off] of triggers) {
		let offAt: number | undefined;
		const run = await runOnce(cwd, { hasUI: false, mode: (read, calls) => { if (off(read, calls)) { offAt ??= calls.length; return "off"; } return "on"; } });
		assert.equal(run.result.outcome, "blocked", `${label}: ${JSON.stringify(run.result)}`);
		assert.equal(run.result.result.outcome, "review-mode-disabled", label);
		assert.notEqual(offAt, undefined, label);
		assert.deepEqual(run.nativeCalls.slice(offAt), [], `${label}: no provider call after the switch reads off`);
		assert.equal(run.relayRuns, 0, label);
		assert.equal(run.closed, false, label);
		if (label === "after the recorded forecast") assert.equal(run.result.forecasts.length, 1, "stopped after the recorded forecast, at the run itself");
	}
});

test("S5: a malformed advisory_findings never closes the run and never reaches its result", async () => {
	const cwd = scratchRepo();
	const marker = "MALFORMED-FINDINGS-MARKER";
	for (const malformed of [[], { statement: marker, findings: [] }, marker, null, { ...structuredClone(FINDINGS), statement: marker, extra: marker }]) {
		const run = await runOnce(cwd, { advisoryFindings: malformed });
		const label = JSON.stringify(malformed);
		assert.notEqual(run.result.outcome, "closed", label);
		assert.equal(run.closed, false, label);
		assert.equal(Object.hasOwn(run.result, "advisory_findings"), false, label);
		assert.doesNotMatch(JSON.stringify(run.result), new RegExp(marker), label);
	}
});

test("S5: an approved run carries the closure's advisory_findings unchanged; absent key stays absent", async () => {
	const cwd = scratchRepo();
	const withFindings = await runOnce(cwd, { advisoryFindings: structuredClone(FINDINGS) });
	assert.equal(withFindings.result.outcome, "closed", JSON.stringify(withFindings.result));
	assert.deepEqual(withFindings.result.advisory_findings, FINDINGS);
	assert.equal(Object.hasOwn(withFindings.result.result, "advisory_findings"), false, "the ACK envelope is relayed unchanged");
	const without = await runOnce(cwd, {});
	assert.equal(without.result.outcome, "closed");
	assert.equal(Object.hasOwn(without.result, "advisory_findings"), false);
});

// S2/S3 through a real Pi SDK session: what the provider request contains.
interface RecordedRequest { systemPrompt: string; tools: Tool[] }

async function promptRequest(root: string, label: string, mode: "on" | "off", tools: string[], env: Record<string, string> = {}): Promise<RecordedRequest> {
	const sdk = await import("@earendil-works/pi-coding-agent");
	const ai = await import("@earendil-works/pi-ai");
	const { createGentleAiExtension } = await import("../extensions/gentle-ai.ts");
	const cwd = join(root, `repo-${label}`);
	mkdirSync(cwd);
	execFileSync("git", ["init", "-q", "--initial-branch=fixture"], { cwd, env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
	const profile = join(root, `profile-${label}`);
	mkdirSync(profile);
	const bindings = { PI_CODING_AGENT_DIR: profile, PI_CODING_AGENT_SESSION_DIR: join(root, `sessions-${label}`), GENTLE_PI_AGENT_HOME: profile, GENTLE_PI_CONFIG_HOME: join(root, "config") };
	const previous = Object.fromEntries(Object.keys(bindings).map((key) => [key, process.env[key]]));
	Object.assign(process.env, bindings);
	const requests: RecordedRequest[] = [];
	const model = { id: "driver", name: "Local driver", provider: "one-call-fixture", api: "one-call-fixture", baseUrl: "http://invalid.local", reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;
	const native = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: mode, cloneLocal: "", effective: mode, source: "global" } }),
	} as unknown as NativeReviewCli;
	try {
		const manager = sdk.SessionManager.inMemory(cwd);
		const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", packages: [] });
		const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, `models-${label}.json`), refreshOnCreate: false, allowModelNetwork: false });
		const loader = new sdk.DefaultResourceLoader({
			cwd, agentDir: profile, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi) => {
				createGentleAiExtension({ nativeReviewCli: native, candidateViews: null, processEnv: { ...bindings, ...env, GENTLE_AI_TELEMETRY: "0" }, resolveTelemetryTriggerBinary: () => { throw new Error("fixture"); } })(pi);
				pi.registerProvider("one-call-fixture", {
					api: "one-call-fixture", apiKey: "fixture-only", baseUrl: "http://invalid.local",
					models: [{ id: model.id, name: model.name, reasoning: false, input: ["text"], cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
					streamSimple(_model, context) {
						requests.push({ systemPrompt: ai.getCurrentSystemPrompt(context.messages), tools: ai.getCurrentTools(context.messages) });
						const stream = ai.createAssistantMessageEventStream();
						const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
						queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(); });
						return stream;
					},
				});
			}],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await sdk.createAgentSession({ cwd, agentDir: profile, modelRuntime: runtime, model: model as never, thinkingLevel: "off", resourceLoader: loader, tools, sessionManager: manager, settingsManager: settings });
		try {
			const errors: unknown[] = [];
			await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error.error) });
			await session.prompt("Report the plan.", { source: "interactive" });
			assert.deepEqual(errors, []);
		} finally { await session.abort(); session.dispose(); }
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	assert.equal(requests.length, 1);
	return requests[0]!;
}

const RUN_GUIDANCE = "To drive a due native ordinary review, prefer gentle_review_run over single review operations: it executes the same provider-issued lifecycle (assess, inspect, START, bound STATUS, captures, acknowledgement) in one call. Single operations remain for what its result hands back (the consent answer, the correction plan through gentle_review_capture, status and recovery), for a review the user explicitly asks for after not-due, and for ASSESS after a delegated writer.";
const CONSENT_GUIDANCE = "On consent-required, relay the consent to the human and submit only the human's explicit answer, once, with gentle_review answer-consent. Never choose the answer yourself and never pass a consent answer to gentle_review_run.";
const RUN_OUTCOMES = ["closed", "not-due", "assessment-unavailable", "request-context-requires-fresh-review", "consent-required", "input-required", "stopped", "handoff", "repeated-capture", "forecast", "binding-drift", "transition-limit", "blocked"];

test("S3/S6: the run guidance keeps consent with the human, scopes the run to a due review and names every outcome", () => {
	const tools = new Map<string, { description: string; promptGuidelines: string[] }>();
	createGentleAiExtension({ nativeReviewCli: null, processEnv: {} })({ on() {}, registerCommand() {}, registerTool: (tool: never) => tools.set((tool as { name: string }).name, tool) } as never);
	const run = tools.get("gentle_review_run")!;
	assert.ok(run.promptGuidelines.includes(RUN_GUIDANCE));
	assert.ok(run.promptGuidelines.includes(CONSENT_GUIDANCE));
	assert.ok(run.promptGuidelines.includes("Supply the exact candidate selector and pertinent lenses with a reason. Resume with lineageId and the same workspaceRoot/baseRef after an answered consent or an authorized correction edit. Correction edits and maintenance remain explicit handoffs."));
	const text = [run.description, ...run.promptGuidelines].join("\n");
	for (const removed of ["relay consent-required and answer it once", "only for what its result names"]) assert.equal(text.includes(removed), false, removed);
	for (const outcome of RUN_OUTCOMES) assert.match(run.description, new RegExp(`(^|[ (,])${outcome}([ ),.]|$)`), outcome);
	assert.match(run.description, /maintenance/);
});

test("S2/S3: RDD on declares gentle_review_run with its one-call guidance; RDD off leaves the request byte-identical", { timeout: 60_000 }, async (t) => {
	const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "rdd-one-call-sdk-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const family = ["read", "gentle_review", "gentle_review_capture", "gentle_review_capture_group", "gentle_review_scope"];
	const on = await promptRequest(root, "on", "on", [...family, "gentle_review_run"]);
	assert.match(on.systemPrompt, /Receipt-driven development: on /);
	assert.ok(on.tools.some((tool) => tool.name === "gentle_review_run"), "registered without GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR=1");
	assert.ok(on.systemPrompt.includes(RUN_GUIDANCE), "the run guidance renders while RDD is on");
	// Equal-length labels: each session's repository path appears in its prompt.
	const off = await promptRequest(root, "off-1", "off", [...family, "gentle_review_run"]);
	const offWithout = await promptRequest(root, "off-2", "off", family);
	assert.match(off.systemPrompt, /Receipt-driven development: off /);
	assert.equal(off.tools.some((tool) => tool.name === "gentle_review_run"), false);
	assert.equal(off.systemPrompt.includes("gentle_review_run"), false);
	assert.equal(off.systemPrompt.replaceAll("off-1", "off-2"), offWithout.systemPrompt, "RDD off: the system prompt does not change by one byte");
	assert.equal(JSON.stringify(off.tools), JSON.stringify(offWithout.tools), "RDD off: the declared tools do not change by one byte");
	const optedOut = await promptRequest(root, "opt-out", "on", [...family, "gentle_review_run"], { GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR: "0" });
	assert.equal(optedOut.tools.some((tool) => tool.name === "gentle_review_run"), false, "GENTLE_PI_EXPERIMENTAL_REVIEW_COORDINATOR=0 opts out");
});

// S6: the run never answers the START consent. A provider START that requires
// consent returns consent-required without a UI and when the human cancels the
// dialog; the provider receives no answer and the run took only assess, inspect, start.
function consentHarness(root: string) {
	const raw = JSON.parse(readFileSync(new URL("./fixtures/devbinary/consent-v3.captured.json", import.meta.url), "utf8"));
	raw.agent = "pi";
	const decoded = decodeReviewConsentV3(raw, "pi");
	const consent = { ...decoded, choices: decoded.choices.map((choice) => ({ ...choice, invocation: choice.invocation.replace(" --consent ", " --agent pi --consent ") })) };
	const cwd = realpathSync(mkdtempSync(join(root, "consent-repo-")));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
	git("init", "-q", "-b", "main"); writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n"); git("add", "app.ts");
	git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "base"); writeFileSync(join(cwd, "app.ts"), "export const value = 2;\n");
	const digest = `sha256:${"a".repeat(64)}`;
	const startStatus = () => {
		const views = new CandidateViewRegistry(); const view = views.create({ contributorRoot: cwd });
		try {
			return { contract: "gentle-ai.review-integration/v2", applicability: "unrelated", action: "start", replayability: "not_replayable", targetIdentity: digest,
				projection: { schema: "gentle-ai.review-candidate-projection/v1", kind: "current-changes", projection: "workspace", baseTree: view.baseTree, initialReviewTree: view.candidateTree, currentCandidateTree: view.candidateTree, pathsDigest: digest, paths: [...view.paths], intendedUntracked: [], intendedUntrackedProof: digest, initialSnapshotIdentity: digest, currentSnapshotIdentity: digest },
				candidates: [], nextTransition: { kind: "execute", reasonCode: "start_required", execute: { operation: "review.start", command: "gentle-ai review start --fixture", arguments: [], preconditions: [] } },
				raw: { schema: "gentle-ai.review-integration.status/v5", next_transition: { kind: "execute", reason_code: "start_required", execute: { operation: "review.start" } } } };
		} finally { views.cleanup(view.token); }
	};
	const answers: string[] = [];
	const native = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "", effective: "on", source: "global" } }),
		assess: async () => ({ schema: "gentle-ai.review-assessment/v1", risk: "high", reasons: [], changedPaths: 1, changedLines: 1, reviewDue: true, reviewDueReason: "high_risk", candidate: { kind: "current-changes", consumed: false } }),
		targetStatus: async () => startStatus(),
		start: async () => { throw new NativeReviewConsentRequiredError(consent as never); },
		answerConsent: async (request: { answer: string }) => { answers.push(request.answer); throw new Error("the run must never answer consent"); },
	} as unknown as NativeReviewCli;
	const tools = new Map<string, any>();
	const candidateViews = new CandidateViewRegistry();
	createGentleAiExtension({ nativeReviewCli: native, candidateViews, processEnv: { GENTLE_AI_TELEMETRY: "0" } })({ on() {}, registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool), events: { emit() {} } } as never);
	return { cwd, answers, candidateViews, run: tools.get("gentle_review_run") };
}

test("S6: START consent returns consent-required without a UI and when the human cancels; no consent answer is sent", async (t) => {
	const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "rdd-one-call-consent-")));
	const harnesses: ReturnType<typeof consentHarness>[] = [];
	t.after(() => {
		for (const h of harnesses) h.candidateViews.cleanupAll();
		rmSync(root, { recursive: true, force: true });
	});
	// A human who cancels the consent dialog with Escape.
	const cancel = async (factory: any) => {
		let result: unknown;
		const component = factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, undefined, (value: unknown) => { result = value; });
		component.render(80); component.handleInput?.("\u001b");
		return result;
	};
	for (const [label, hasUI] of [["no UI", false], ["UI, human cancels", true]] as const) {
		const h = consentHarness(root);
		harnesses.push(h);
		let prompts = 0;
		const ctx = { cwd: h.cwd, mode: hasUI ? "tui" : "print", hasUI, sessionManager: { getSessionId: () => `consent-${label}`, getBranch: () => [], getSessionFile: () => undefined },
			ui: { custom: async (factory: unknown) => { prompts++; return hasUI ? await cancel(factory) : undefined; }, select: async () => undefined, notify() {}, setStatus() {}, theme: { fg: (_color: string, text: string) => text } } };
		const result = (await h.run.execute("consent", { lenses: ["risk"], lensesReason: "consent fixture" }, undefined, () => {}, ctx)).details;
		assert.equal(result.outcome, "consent-required", `${label}: ${JSON.stringify(result)}`);
		assert.deepEqual(h.answers, [], label);
		assert.deepEqual(result.metrics.steps.map((step: { tool: string; operation?: string }) => `${step.tool}:${step.operation}`), ["gentle_review:assess", "gentle_review:inspect", "gentle_review:start"], label);
		assert.equal(prompts, hasUI ? 1 : 0, `${label}: the consent dialog is shown only with a UI`);
	}
});
