import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { __testing, createGentleAiExtension, PendingReviewConsentRegistry } from "../extensions/gentle-ai.ts";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import {
	NATIVE_REVIEW_ERROR_CODE,
	NATIVE_REVIEW_MODE_OPERATION,
	NATIVE_REVIEW_OPERATION,
	NativeReviewCliError,
	NativeReviewCliV216,
	NativeReviewIntegrationError,
	NativeReviewConsentRequiredError,
	nativeRiskEvidencePhrases,
	normalizeNativeReviewCwd,
	type NativeReviewCli,
	type ExecFileAdapter,
} from "../lib/native-review-cli.ts";
import {
	decodeReviewConsentV3,
	decodeReviewFailureV2,
	decodeReviewLastEventClosureV1,
	decodeReviewStartV3,
	type ReviewStatusV3,
} from "../lib/review-integration-v2.ts";

const CAPTURED_FIXTURES = join(process.cwd(), "tests", "fixtures", "devbinary");

function captured(name: string): unknown {
	return JSON.parse(readFileSync(join(CAPTURED_FIXTURES, name), "utf8"));
}

test("captured native start and terminal capture decode as one last-event lifecycle", () => {
	const start = decodeReviewStartV3(captured("start-v3-zero-lens-closed.captured.json"));
	const closure = decodeReviewLastEventClosureV1(captured("last-event-capture-result-approved.captured.json"));
	assert.equal(start.action, "closed");
	assert.equal(start.state, "approved");
	assert.equal(closure.operation, "review/capture-result");
	assert.equal(closure.state, "approved");
	assert.notEqual(closure.operation, "review.finalize");
});

function queuedAdapter(stdout: readonly string[]): { adapter: ExecFileAdapter; calls: Array<readonly string[]> } {
	const queue = [...stdout];
	const calls: Array<readonly string[]> = [];
	return {
		calls,
		adapter: async (request) => {
			calls.push(request.arguments);
			const body = queue.shift();
			if (body === undefined) throw new Error("unexpected native invocation");
			return { stdout: body, stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		},
	};
}

function mode(
	operation: "status" | "enable" | "disable",
	effective: "on" | "off",
	source: "default" | "global" | "clone_local",
	reach?: "machine" | "this_build" | "future",
): string {
	const global = source === "global" ? (effective === "on" ? "on" : "off") : source === "clone_local" ? "on" : "";
	const cloneLocal = source === "clone_local" ? "off" : "";
	return JSON.stringify({
		schema: "gentle-ai.review-mode/v1",
		operation,
		scope: "clone",
		status: { schema: "gentle-ai.rdd-mode-status/v1", global, clone_local: cloneLocal, effective, source, ...(reach === undefined ? {} : { reach }) },
	});
}

test("review mode STATUS keeps the provider-decided default-off source", async () => {
	const queue = queuedAdapter([mode("status", "off", "default")]);
	const result = await new NativeReviewCliV216(queue.adapter, "/package/.gentle-ai/gentle-ai").reviewMode({ cwd: process.cwd(), operation: NATIVE_REVIEW_MODE_OPERATION.STATUS });
	assert.equal(result.status.effective, "off");
	assert.equal(result.status.source, "default");
	assert.deepEqual(queue.calls[0], ["review", "mode", "status", "--cwd", process.cwd(), "--json"]);
});

test("review mode mutations remain clone-scoped and retain their exact operation discriminator", async () => {
	const queue = queuedAdapter([mode("disable", "off", "clone_local"), mode("enable", "on", "global")]);
	const review = new NativeReviewCliV216(queue.adapter, "/package/.gentle-ai/gentle-ai");
	assert.equal((await review.reviewMode({ cwd: process.cwd(), operation: NATIVE_REVIEW_MODE_OPERATION.DISABLE })).operation, "disable");
	assert.equal((await review.reviewMode({ cwd: process.cwd(), operation: NATIVE_REVIEW_MODE_OPERATION.ENABLE })).operation, "enable");
	assert.deepEqual(queue.calls.map((arguments_) => arguments_.slice(-3)), [["--scope", "clone", "--json"], ["--scope", "clone", "--json"]]);
});

test("review mode rejects a response with a foreign operation discriminator", async () => {
	const queue = queuedAdapter([mode("enable", "on", "global")]);
	await assert.rejects(
		() => new NativeReviewCliV216(queue.adapter, "/package/.gentle-ai/gentle-ai").reviewMode({ cwd: process.cwd(), operation: NATIVE_REVIEW_MODE_OPERATION.STATUS }),
		/schema incompatible/,
	);
});

test("all terminal capture fixtures retain exact, non-interchangeable operation identities", () => {
	assert.equal(decodeReviewLastEventClosureV1(captured("last-event-capture-refuter-approved.captured.json")).operation, "review.capture-refuter");
	assert.equal(decodeReviewLastEventClosureV1(captured("last-event-capture-validation-approved.captured.json")).operation, "review/capture-validation");
	assert.equal(decodeReviewLastEventClosureV1(captured("last-event-capture-result-approved.captured.json")).operation, "review/capture-result");
});

test("native risk evidence derives only published medium and high risk phrases", () => {
	assert.deepEqual(nativeRiskEvidencePhrases("low", [{ code: "process_boundary", path: "runner.ts" }]), []);
	assert.deepEqual(nativeRiskEvidencePhrases("medium", [{ code: "process_boundary", path: "runner.ts" }]), [
		"this change is not purely passive documentation, so it gets one consolidated review.",
		"code that starts other processes in runner.ts",
	]);
	assert.deepEqual(nativeRiskEvidencePhrases("high", [{ code: "hot_path", signal: "auth", path: "auth.ts" }, { code: "unknown", path: "ignored.ts" }]), ["authentication in auth.ts"]);
});

test("Windows native cwd normalization preserves drive identity without changing POSIX paths", () => {
	assert.equal(normalizeNativeReviewCwd("/c/Users/example/repo", "win32"), "C:\\Users\\example\\repo");
	assert.equal(normalizeNativeReviewCwd("c:\\Users\\example\\repo", "win32"), "C:\\Users\\example\\repo");
	assert.equal(normalizeNativeReviewCwd("/repo with spaces", "linux"), "/repo with spaces");
});

test("current review mode keeps canonical reach values and rejects unrecognized wire values", async (t) => {
	for (const reach of ["machine", "this_build"] as const) {
		const queue = queuedAdapter([mode("status", "off", "clone_local", reach)]);
		const result = await new NativeReviewCliV216(queue.adapter, "/package/.gentle-ai/gentle-ai").reviewMode({ cwd: process.cwd(), operation: NATIVE_REVIEW_MODE_OPERATION.STATUS });
		assert.equal(result.status.reach, reach);
	}
	const malformed = queuedAdapter([mode("status", "off", "clone_local", "future")]);
	await assert.rejects(
		() => new NativeReviewCliV216(malformed.adapter, "/package/.gentle-ai/gentle-ai").reviewMode({ cwd: process.cwd(), operation: NATIVE_REVIEW_MODE_OPERATION.STATUS }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE,
	);
	if (process.platform !== "win32") {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-review-mode-")));
		const alias = `${root}-alias`;
		const { symlinkSync } = await import("node:fs");
		symlinkSync(root, alias, "dir");
		t.after(() => {
			rmSync(alias, { force: true });
			rmSync(root, { recursive: true, force: true });
		});
		const observed: string[] = [];
		const adapter: ExecFileAdapter = async (request) => {
			observed.push(request.cwd);
			return { stdout: mode("status", "off", "global"), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		};
		await new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai").reviewMode({ cwd: alias, operation: NATIVE_REVIEW_MODE_OPERATION.STATUS });
		assert.deepEqual(observed, [root]);
	}
});

test("published start/v3 wire rejects scalar risk reasons without Pi lens policy", () => {
	const start = captured("start-v3-zero-lens-closed.captured.json") as Record<string, unknown>;
	assert.throws(() => decodeReviewStartV3({ ...start, risk_reasons: "not-an-array" }), /risk_reasons/);
});

interface RegisteredControllerTool {
	execute: (
		toolCallId: string,
		parameters: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	) => Promise<{ details?: unknown }>;
}

interface RegisteredCommand {
	handler: (args: string, context: ExtensionContext) => Promise<void>;
}

interface RegisteredEvent {
	(event: unknown, context: ExtensionContext): Promise<unknown> | unknown;
}

interface ParityRuntime {
	controller: RegisteredControllerTool;
	commands: Map<string, RegisteredCommand>;
	events: Map<string, RegisteredEvent>;
}

interface ParityRuntimeOptions {
	candidateViews?: CandidateViewRegistry;
	pendingReviewConsentRegistry?: PendingReviewConsentRegistry;
	now?: () => number;
	scheduleTimer?: (callback: () => void, delayMs: number) => { unref: () => void };
}

function parityRuntime(nativeReviewCli: NativeReviewCli | null, options: ParityRuntimeOptions = {}): ParityRuntime {
	const tools = new Map<string, RegisteredControllerTool>();
	const commands = new Map<string, RegisteredCommand>();
	const events = new Map<string, RegisteredEvent>();
	const dependencies = {
		nativeReviewCli,
		candidateViews: options.candidateViews ?? new CandidateViewRegistry(),
		pendingReviewConsentRegistry: options.pendingReviewConsentRegistry ?? new PendingReviewConsentRegistry(),
		now: options.now,
		scheduleTimer: options.scheduleTimer,
	} as unknown as Parameters<typeof createGentleAiExtension>[0];
	__testing.createGentleAiExtension(dependencies)({
		on(name: string, handler: RegisteredEvent) { events.set(name, handler); },
		registerTool(definition: RegisteredControllerTool & { name: string }) { tools.set(definition.name, definition); },
		registerCommand(name: string, definition: RegisteredCommand) { commands.set(name, definition); },
	} as unknown as ExtensionAPI);
	const controller = tools.get("gentle_review");
	assert.ok(controller);
	return { controller: controller!, commands, events };
}

function repository(t: test.TestContext): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-native-parity-")));
	t.after(() => {
		try { execFileSync("chmod", ["-R", "u+w", cwd], { stdio: "ignore" }); } catch { /* best effort */ }
		rmSync(cwd, { recursive: true, force: true });
	});
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "app.ts"], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Parity Test", "-c", "user.email=parity@example.invalid", "commit", "-m", "base"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, "app.ts"), "export const value = 2;\n");
	return cwd;
}

function startStatus(cwd: string): ReviewStatusV3 {
	const candidates = new CandidateViewRegistry();
	const candidate = candidates.create({ contributorRoot: cwd });
	try {
		return {
			contract: "gentle-ai.review-integration/v2",
			applicability: "unrelated",
			action: "start",
			replayability: "not_replayable",
			targetIdentity: `sha256:${"a".repeat(64)}`,
			projection: {
				schema: "gentle-ai.review-candidate-projection/v1",
				kind: "current-changes",
				projection: "workspace",
				baseTree: candidate.baseTree,
				initialReviewTree: candidate.candidateTree,
				currentCandidateTree: candidate.candidateTree,
				pathsDigest: `sha256:${"a".repeat(64)}`,
				paths: [...candidate.paths],
				intendedUntracked: [],
				intendedUntrackedProof: `sha256:${"a".repeat(64)}`,
				initialSnapshotIdentity: `sha256:${"a".repeat(64)}`,
				currentSnapshotIdentity: `sha256:${"a".repeat(64)}`,
			},
			candidates: [],
			raw: { schema: "gentle-ai.review-integration.status/v5" },
		} as unknown as ReviewStatusV3;
	} finally {
		candidates.cleanup(candidate.token);
	}
}

function context(cwd: string, sessionId = "parity-session", notices: Array<{ message: string; type?: string }> = []): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		ui: { notify: (message: string, type?: string) => { notices.push({ message, type }); } },
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;
}

async function executeController(runtime: ParityRuntime, operation: unknown, cwd: string, sessionId = "parity-session"): Promise<Record<string, unknown>> {
	const response = await runtime.controller.execute("parity-controller", operation, undefined, undefined, context(cwd, sessionId));
	return response.details as Record<string, unknown>;
}

function consentNative(cwd: string): { native: NativeReviewCli; starts: { count: number }; answers: string[] } {
	const consent = decodeReviewConsentV3(captured("consent-v3.captured.json"));
	const starts = { count: 0 };
	const answers: string[] = [];
	return {
		starts,
		answers,
		native: {
			targetStatus: async () => startStatus(cwd),
			start: async () => {
				starts.count += 1;
				throw new NativeReviewConsentRequiredError(consent);
			},
			answerConsent: async (request) => {
				answers.push(request.answer);
				if (request.answer === "declined") {
					return {
						kind: "declined",
						targetIdentity: consent.targetIdentity,
						projection: consent.projection,
						riskLevel: consent.riskLevel,
						changedFiles: consent.changedFiles,
						changedLines: consent.changedLines,
						consent: "declined_this_candidate",
						raw: { operation: "review/start", action: "declined", consent: "declined_this_candidate" },
					};
				}
				return {
					kind: "started",
					start: {
						lineageId: "consent-lineage",
						state: "approved",
						riskLevel: "high",
						selectedLenses: [],
						changedFiles: consent.changedFiles,
						changedLines: consent.changedLines,
						correctionBudget: 0,
						action: "closed",
						lensesRequired: false,
						riskReasons: [],
					},
				};
			},
			sddStatus: async () => ({ ready: false, artifactStore: "none", artifacts: {}, nextRecommended: "propose" }),
			reviewStatus: async () => ({ schema: "gentle-ai.review-authority-status/v1", repository: cwd, complete: true, authoritative: true, status: "clean", entries: [], locks: [], diagnostics: [], raw: {} }),
		} as unknown as NativeReviewCli,
	};
}

async function beginConsent(runtime: ParityRuntime, cwd: string, sessionId = "parity-session"): Promise<Record<string, unknown>> {
	const blocked = await executeController(runtime, { operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, sessionId);
	assert.equal(blocked.outcome, "native-review-consent-required");
	assert.equal(typeof blocked.consent_binding, "string");
	return blocked;
}

async function answerConsent(runtime: ParityRuntime, cwd: string, binding: unknown, answer: "granted" | "declined", sessionId = "parity-session"): Promise<Record<string, unknown>> {
	return await executeController(runtime, { operation: "answer-consent", input: JSON.stringify({ consentBinding: binding, answer }) }, cwd, sessionId);
}

// gentle-pi#516: an unknown or expired binding is a typed, blocked outcome
// that names itself and its exit. It still carries the current negotiated
// STATUS as reconciliation context, but it never reads as a healthy
// pre-start "ready".
function assertStaleConsentBinding(outcome: Record<string, unknown>, binding: unknown, code: "consent-binding-unknown" | "consent-binding-expired" | "consent-binding-already-consumed"): void {
	assert.equal(outcome.status, "blocked");
	assert.equal(outcome.outcome, "consent-binding-stale");
	assert.equal(outcome.consent_binding, binding);
	assert.equal((outcome.diagnostics as { code?: unknown } | undefined)?.code, code);
	assert.match(String((outcome.diagnostics as { message?: unknown } | undefined)?.message), /START again/);
	assert.equal(outcome.native_invocation_attempted, false);
	assert.equal(outcome.lineage_created, false);
	assert.equal(outcome.mutation_performed, false);
	assert.equal(outcome.mutation_outcome, "none");
	assert.equal(outcome.provider_action, "start");
	assert.equal(outcome.next_action, "restart-for-fresh-consent");
}

test("review-mode gate retains every off-source continuation and fails closed on native errors", async () => {
	for (const [source, expected] of [
		["clone_local", /clear this clone-local override/],
		["global", /cannot override a global off/],
		["default", /off by default until explicitly enabled/],
	] as const) {
		const native = {
			reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: source === "global" ? "off" : "", cloneLocal: source === "clone_local" ? "off" : "", effective: "off" as const, source } }),
		} as unknown as NativeReviewCli;
		const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, process.cwd(), native);
		assert.equal(result.outcome, "review-mode-disabled");
		assert.equal(result.mode_source, source);
		assert.match(String(result.next_action), expected);
	}
	const failed = await __testing.executeReviewControllerOperation(
		{ operation: "start", input: JSON.stringify({ mode: "ordinary" }) },
		process.cwd(),
		{ reviewMode: async () => { throw new Error("native mode failure"); } } as unknown as NativeReviewCli,
	);
	assert.equal(failed.outcome, "native-operation-failed");
});

test("public gentle:review-mode handler reports current operations, global-off warnings, and unavailability", async () => {
	const calls: string[] = [];
	const native = {
		reviewMode: async ({ operation }: { operation: "status" | "enable" | "disable" }) => {
			calls.push(operation);
			const globalOff = operation === "enable";
			return {
				operation,
				scope: "clone",
				status: { global: globalOff ? "off" : "", cloneLocal: operation === "disable" ? "off" : "", effective: globalOff || operation === "disable" ? "off" as const : "on" as const, source: globalOff ? "global" as const : operation === "disable" ? "clone_local" as const : "default" as const },
			};
		},
	} as unknown as NativeReviewCli;
	const runtime = parityRuntime(native);
	const command = runtime.commands.get("gentle:review-mode");
	assert.ok(command);
	const notices: Array<{ message: string; type?: string }> = [];
	const ctx = context(process.cwd(), "review-mode-command", notices);
	await command!.handler("status", ctx);
	await command!.handler("disable", ctx);
	await command!.handler("enable", ctx);
	assert.deepEqual(calls, ["status", "disable", "enable"]);
	assert.match(notices[0]?.message ?? "", /receipt-driven development: on/);
	assert.match(notices[1]?.message ?? "", /receipt-driven development: off/);
	assert.equal(notices[2]?.type, "warning");
	assert.match(notices[2]?.message ?? "", /gentle-ai review mode enable --scope=global/);

	const unavailable = parityRuntime({} as NativeReviewCli).commands.get("gentle:review-mode");
	assert.ok(unavailable);
	const unavailableNotices: Array<{ message: string; type?: string }> = [];
	await unavailable!.handler("status", context(process.cwd(), "review-mode-unavailable", unavailableNotices));
	assert.deepEqual(unavailableNotices, [{ message: "Gentle AI review mode is not available with the currently negotiated native version.", type: "info" }]);
});

test("public consent relay allows any active session to resolve a live binding, is one-shot, and is candidate-scoped", async (t) => {
	const cwd = repository(t);
	const sharedRegistry = new PendingReviewConsentRegistry();
	const fixture = consentNative(cwd);
	const first = parityRuntime(fixture.native, { pendingReviewConsentRegistry: sharedRegistry });
	const second = parityRuntime(fixture.native, { pendingReviewConsentRegistry: sharedRegistry });
	const sameSession = await beginConsent(first, cwd, "same-session");
	const sameSessionResult = await answerConsent(second, cwd, sameSession.consent_binding, "declined", "same-session");
	assert.equal(sameSessionResult.outcome, "consent-declined-this-candidate");

	// gentle-pi#455: a binding is answerable by whichever active Pi session
	// presents it, not only the session whose START created it.
	const blockedA = await beginConsent(first, cwd, "session-a");
	assert.deepEqual(blockedA.consent, decodeReviewConsentV3(captured("consent-v3.captured.json")).raw);
	const declinedFromOtherSession = await answerConsent(second, cwd, blockedA.consent_binding, "declined", "session-b");
	assert.equal(declinedFromOtherSession.operation, "answer-consent");
	assert.equal(declinedFromOtherSession.outcome, "consent-declined-this-candidate");
	assert.deepEqual(fixture.answers, ["declined", "declined"]);

	// Cross-session resolution still enforces single use: once answered, no
	// session -- including the one whose START created it -- may answer it again.
	const staleAfterCrossSessionAnswer = await answerConsent(first, cwd, blockedA.consent_binding, "declined", "session-a");
	assert.equal(staleAfterCrossSessionAnswer.operation, "answer-consent");
	assertStaleConsentBinding(staleAfterCrossSessionAnswer, blockedA.consent_binding, "consent-binding-already-consumed");
	assert.deepEqual(fixture.answers, ["declined", "declined"]);

	const blockedB = await beginConsent(second, cwd, "session-b");
	const declined = await answerConsent(second, cwd, blockedB.consent_binding, "declined", "session-b");
	assert.equal(declined.outcome, "consent-declined-this-candidate");
	assert.equal(declined.lineage_created, false);
	const staleConsumed = await answerConsent(second, cwd, blockedB.consent_binding, "declined", "session-b");
	assert.equal(staleConsumed.operation, "answer-consent");
	assertStaleConsentBinding(staleConsumed, blockedB.consent_binding, "consent-binding-already-consumed");
	assert.deepEqual(fixture.answers, ["declined", "declined", "declined"]);

	// A binding still pending when its owning session shuts down is discarded
	// and becomes unreachable to every session -- cross-session resolution
	// included.
	const blockedShutdown = await beginConsent(first, cwd, "session-a");
	const shutdown = first.events.get("session_shutdown");
	assert.ok(shutdown);
	await shutdown!({}, context(cwd, "session-a"));
	await shutdown!({}, context(cwd, "session-a"));
	const staleShutdown = await answerConsent(second, cwd, blockedShutdown.consent_binding, "declined", "session-b");
	assert.equal(staleShutdown.operation, "answer-consent");
	assertStaleConsentBinding(staleShutdown, blockedShutdown.consent_binding, "consent-binding-unknown");

	writeFileSync(join(cwd, "app.ts"), "export const value = 3;\n");
	const nextCandidate = await beginConsent(second, cwd, "session-b");
	assert.notEqual(nextCandidate.consent_binding, blockedB.consent_binding);
	fixture.native.reviewMode = async ({ operation }) => ({
		operation,
		scope: "clone",
		status: { global: "", cloneLocal: "off", effective: "off", source: "clone_local" },
	});
	const disable = second.commands.get("gentle:review-mode");
	assert.ok(disable);
	await disable!.handler("disable", context(cwd, "session-b"));
	const staleModeCleared = await answerConsent(second, cwd, nextCandidate.consent_binding, "declined", "session-b");
	assert.equal(staleModeCleared.operation, "answer-consent");
	assertStaleConsentBinding(staleModeCleared, nextCandidate.consent_binding, "consent-binding-unknown");
	assert.equal(fixture.starts.count, 5);
});

test("already-consumed local consent bindings reconcile exactly once with the native status transition", async (t) => {
	const cwd = repository(t);
	const fixture = consentNative(cwd);
	const nextTransition = {
		kind: "execute",
		reason_code: "fresh_start_available",
		execute: { operation: "review.start", arguments: ["opaque-native-start-token"] },
	};
	const reconciledStatus = {
		...startStatus(cwd),
		raw: { schema: "gentle-ai.review-integration.status/v5", next_transition: nextTransition },
	} as ReviewStatusV3;
	const statusRequests: Array<{ agent?: string }> = [];
	fixture.native.targetStatus = async (request) => {
		statusRequests.push(request);
		return reconciledStatus;
	};
	const runtime = parityRuntime(fixture.native);
	const blocked = await beginConsent(runtime, cwd);
	await answerConsent(runtime, cwd, blocked.consent_binding, "declined");

	const reconciled = await answerConsent(runtime, cwd, blocked.consent_binding, "declined");
	assert.equal(reconciled.operation, "answer-consent");
	assertStaleConsentBinding(reconciled, blocked.consent_binding, "consent-binding-already-consumed");
	assert.deepEqual(reconciled.result, reconciledStatus.raw);
	assert.deepEqual((reconciled.result as { next_transition?: unknown }).next_transition, nextTransition);
	assert.equal(statusRequests.length, 2, "the stale binding performs one reconciliation after the initial START status");
	assert.equal(statusRequests[1]?.agent, "pi", "stale binding reconciliation must retain the Pi host transport identity");
	assert.equal(fixture.starts.count, 1, "stale binding recovery must not start a new review automatically");
	assert.deepEqual(fixture.answers, ["declined"], "stale binding recovery must not replay answer-consent");
});

test("launched answer-consent failures remain blocked after fresh-target STATUS reconciliation", async (t) => {
	const cwd = repository(t);
	const fixture = consentNative(cwd);
	const statusRequests: Array<{ agent?: string }> = [];
	const freshTargetStatus = {
		...startStatus(cwd),
		raw: { schema: "gentle-ai.review-integration.status/v5", next_transition: { kind: "execute", reason_code: "fresh_start_available" } },
	} as ReviewStatusV3;
	fixture.native.targetStatus = async (request) => {
		statusRequests.push(request);
		return freshTargetStatus;
	};
	let answerCalls = 0;
	fixture.native.answerConsent = async () => {
		answerCalls += 1;
		throw {
			name: "NativeReviewCliError",
			code: NATIVE_REVIEW_ERROR_CODE.NON_ZERO,
			mutationOutcome: "unknown",
			nextAction: "review.status",
			diagnostics: {
				operation: NATIVE_REVIEW_OPERATION.START,
				error_code: NATIVE_REVIEW_ERROR_CODE.NON_ZERO,
				timed_out: false,
				output_limit_exceeded: false,
			},
		};
	};
	const runtime = parityRuntime(fixture.native);
	const blocked = await beginConsent(runtime, cwd);

	const first = await answerConsent(runtime, cwd, blocked.consent_binding, "granted");
	assert.equal(first.operation, "answer-consent");
	assert.equal(first.status, "blocked");
	assert.equal(first.outcome, "native-mutation-status-reconciled");
	assert.deepEqual(first.diagnostics, {
		operation: NATIVE_REVIEW_OPERATION.START,
		error_code: NATIVE_REVIEW_ERROR_CODE.NON_ZERO,
		timed_out: false,
		output_limit_exceeded: false,
	});
	assert.deepEqual(first.reconciliation, freshTargetStatus.raw);
	assert.match(String(first.required_status_action), /Run target-scoped review\.status/);
	assert.equal(first.next_action, "start");
	assert.equal(statusRequests.length, 2, "the launched failure reconciles exactly once after the initial START status");
	assert.equal(answerCalls, 1, "reconciliation must not replay answer-consent");

	const stale = await answerConsent(runtime, cwd, blocked.consent_binding, "granted");
	assertStaleConsentBinding(stale, blocked.consent_binding, "consent-binding-already-consumed");
	assert.equal(statusRequests.length, 3, "a later already-consumed binding performs one current STATUS read");
	assert.equal(answerCalls, 1, "the stale binding must not replay answer-consent");
});

test("stale local consent bindings preserve a typed native STATUS failure", async (t) => {
	const cwd = repository(t);
	const fixture = consentNative(cwd);
	const runtime = parityRuntime(fixture.native);
	const blocked = await beginConsent(runtime, cwd);
	await answerConsent(runtime, cwd, blocked.consent_binding, "declined");
	fixture.native.targetStatus = async () => {
		throw new NativeReviewCliError(
			NATIVE_REVIEW_ERROR_CODE.TIMEOUT,
			NATIVE_REVIEW_OPERATION.STATUS,
			true,
			false,
			"native STATUS timed out",
		);
	};

	const failed = await answerConsent(runtime, cwd, blocked.consent_binding, "declined");
	assert.equal(failed.operation, "answer-consent");
	assert.equal(failed.status, "blocked");
	assert.equal(failed.outcome, "native-status-unavailable");
	assert.deepEqual(failed.diagnostics, {
		operation: NATIVE_REVIEW_OPERATION.STATUS,
		error_code: NATIVE_REVIEW_ERROR_CODE.TIMEOUT,
		timed_out: false,
		output_limit_exceeded: false,
	});
	assert.equal(fixture.starts.count, 1, "native STATUS failure must not start a new review");
	assert.deepEqual(fixture.answers, ["declined"], "native STATUS failure must not replay answer-consent");

	delete fixture.native.targetStatus;
	const unsupported = await answerConsent(runtime, cwd, blocked.consent_binding, "declined");
	assert.equal(unsupported.operation, "answer-consent");
	assert.equal(unsupported.status, "blocked");
	assert.equal(unsupported.outcome, "native-status-unsupported");
	assert.equal(fixture.starts.count, 1, "unavailable native STATUS must not start a new review");
	assert.deepEqual(fixture.answers, ["declined"], "unavailable native STATUS must not replay answer-consent");
});

test("stale local consent bindings retain typed Pi transport refusal without an agentless retry", async (t) => {
	const cwd = repository(t);
	const fixture = consentNative(cwd);
	const statusRequests: Array<{ agent?: string }> = [];
	fixture.native.targetStatus = async (request) => {
		statusRequests.push(request);
		throw new NativeReviewIntegrationError(decodeReviewFailureV2({
			schema: "gentle-ai.review-integration.failure/v2",
			contract: "gentle-ai.review-integration/v2",
			operation: "review.status",
			phase: "preflight",
			code: "unsupported_agent",
			message: "The native provider does not support Pi host transport.",
			mutation_outcome: "not_started",
			authority_applicability: "not_evaluated",
			retry_safe: true,
			replayability: "not_replayable",
			required_inputs: [],
			next_action: "review.status",
		}));
	};
	const runtime = parityRuntime(fixture.native);

	const refused = await answerConsent(runtime, cwd, "missing-consent-binding", "declined");
	assert.equal(refused.operation, "answer-consent");
	assert.equal(refused.status, "blocked");
	assert.equal(refused.outcome, "pi-host-relay-transport-unavailable");
	assert.deepEqual(refused.relay_transport, {
		supported: false,
		code: "unsupported_agent",
		message: "The native provider does not support Pi host transport.",
	});
	assert.equal(statusRequests.length, 1, "typed Pi transport refusal must not retry STATUS without an agent");
	assert.equal(statusRequests[0]?.agent, "pi");
	assert.equal(fixture.starts.count, 0, "stale binding transport refusal must not start a review");
	assert.deepEqual(fixture.answers, [], "stale binding transport refusal must not replay answer-consent");
});

test("unavailable and ambiguous consent follow-ups never replay a consumed binding", async (t) => {
	const cwd = repository(t);
	const unavailableFixture = consentNative(cwd);
	delete unavailableFixture.native.answerConsent;
	const unavailableRuntime = parityRuntime(unavailableFixture.native);
	const unavailable = await beginConsent(unavailableRuntime, cwd);
	await assert.rejects(
		() => answerConsent(unavailableRuntime, cwd, unavailable.consent_binding, "declined"),
		/consent follow-up is unavailable/,
	);

	const ambiguousFixture = consentNative(cwd);
	let statusCalls = 0;
	const targetStatus = ambiguousFixture.native.targetStatus!;
	ambiguousFixture.native.targetStatus = async (request) => {
		statusCalls += 1;
		return await targetStatus(request);
	};
	ambiguousFixture.native.answerConsent = async () => {
		throw Object.assign(new Error("ambiguous provider mutation"), { mutationOutcome: "unknown", nextAction: "review.status" });
	};
	const ambiguousRuntime = parityRuntime(ambiguousFixture.native);
	const ambiguous = await beginConsent(ambiguousRuntime, cwd);
	const outcome = await answerConsent(ambiguousRuntime, cwd, ambiguous.consent_binding, "granted");
	assert.equal(outcome.operation, "answer-consent");
	assert.ok(statusCalls >= 2, "ambiguous consent re-enters read-only STATUS after the initial START status");
	const callsBeforeStaleReconciliation = statusCalls;
	const stale = await answerConsent(ambiguousRuntime, cwd, ambiguous.consent_binding, "granted");
	assert.equal(stale.operation, "answer-consent");
	assertStaleConsentBinding(stale, ambiguous.consent_binding, "consent-binding-already-consumed");
	assert.equal(statusCalls, callsBeforeStaleReconciliation + 1, "already-consumed binding reconciliation performs exactly one additional STATUS call");
});

test("concurrent answers atomically claim consent before review-mode gating and ignore a queued expiry callback", async (t) => {
	const cwd = repository(t);
	const fixture = consentNative(cwd);
	const candidateViews = new CandidateViewRegistry();
	const cleanup = candidateViews.cleanup.bind(candidateViews);
	let cleanupCalls = 0;
	candidateViews.cleanup = (token) => {
		cleanupCalls += 1;
		cleanup(token);
	};
	const scheduled: Array<() => void> = [];
	let releaseModeGate: (() => void) | undefined;
	const modeGate = new Promise<void>((resolve) => { releaseModeGate = resolve; });
	let modeCalls = 0;
	const statusRequests: Array<{ agent?: string }> = [];
	fixture.native.targetStatus = async (request) => {
		statusRequests.push(request);
		return startStatus(cwd);
	};
	let releaseProvider: (() => void) | undefined;
	const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
	const nativeAnswer = fixture.native.answerConsent!;
	let nativeAnswerCalls = 0;
	fixture.native.answerConsent = async (request) => {
		nativeAnswerCalls += 1;
		assert.equal(cleanupCalls, 0, "a queued expiry callback must not clean claimed candidate authority before the provider answer");
		await providerGate;
		return await nativeAnswer(request);
	};
	const runtime = parityRuntime(fixture.native, {
		candidateViews,
		scheduleTimer: (callback) => { scheduled.push(callback); return { unref() {} }; },
	});
	const blocked = await beginConsent(runtime, cwd);
	fixture.native.reviewMode = async () => {
		modeCalls += 1;
		if (modeCalls === 1) await modeGate;
		return {
			operation: "status",
			scope: "clone",
			status: { global: "", cloneLocal: "", effective: "on", source: "default" },
		};
	};

	const first = answerConsent(runtime, cwd, blocked.consent_binding, "declined");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(modeCalls, 1, "the first answer pauses at the asynchronous review-mode gate");
	const second = answerConsent(runtime, cwd, blocked.consent_binding, "declined");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(scheduled.length, 1);
	scheduled[0]!();
	assert.equal(cleanupCalls, 0, "a queued expiry callback is a harmless no-op after the answer claim");

	releaseModeGate!();
	releaseProvider!();
	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert.equal(firstResult.outcome, "consent-declined-this-candidate");
	assertStaleConsentBinding(secondResult, blocked.consent_binding, "consent-binding-already-consumed");
	assert.equal(nativeAnswerCalls, 1, "only the atomically claimed answer may invoke native answer-consent");
	assert.equal(statusRequests.length, 2, "the losing concurrent answer performs one STATUS reconciliation after the initial START status");
	assert.equal(statusRequests[1]?.agent, "pi", "the losing answer keeps Pi host transport for STATUS reconciliation");
	assert.equal(cleanupCalls, 1, "only the answered binding cleans candidate authority");
});

test("timer-cleaned and synchronously pruned consent bindings remain expired within their session", async (t) => {
	const cwd = repository(t);
	const fixture = consentNative(cwd);
	const registry = new PendingReviewConsentRegistry();
	const start = 1_000;
	let now = start;
	const scheduled: Array<() => void> = [];
	const runtime = parityRuntime(fixture.native, {
		pendingReviewConsentRegistry: registry,
		now: () => now,
		scheduleTimer: (callback) => { scheduled.push(callback); return { unref() {} }; },
	});
	const first = await beginConsent(runtime, cwd);
	const reused = await beginConsent(runtime, cwd);
	assert.equal(reused.consent_binding, first.consent_binding);
	assert.equal(scheduled.length, 1);
	now += 10 * 60 * 1000;
	// The real TTL callback drops the frozen candidate immediately. Its
	// session-local disposition remains only to classify this stale answer.
	scheduled[0]!();
	const timerExpired = await answerConsent(runtime, cwd, first.consent_binding, "declined");
	assert.equal(timerExpired.operation, "answer-consent");
	assertStaleConsentBinding(timerExpired, first.consent_binding, "consent-binding-expired");
	assert.match(String((timerExpired.diagnostics as { message?: unknown }).message), /expired after 10 minutes/);
	const second = await beginConsent(runtime, cwd);
	assert.notEqual(second.consent_binding, first.consent_binding);
	assert.equal(scheduled.length, 2);
	assertStaleConsentBinding(await answerConsent(runtime, cwd, first.consent_binding, "declined"), first.consent_binding, "consent-binding-expired");

	// No second callback runs: START synchronously prunes this unused binding
	// before it can reuse the frozen candidate, and its answer stays typed expiry.
	now += 10 * 60 * 1000;
	const third = await beginConsent(runtime, cwd);
	assert.notEqual(third.consent_binding, second.consent_binding);
	assertStaleConsentBinding(await answerConsent(runtime, cwd, second.consent_binding, "declined"), second.consent_binding, "consent-binding-expired");

	const reloaded = parityRuntime(fixture.native, { pendingReviewConsentRegistry: new PendingReviewConsentRegistry() });
	assertStaleConsentBinding(await answerConsent(reloaded, cwd, first.consent_binding, "declined"), first.consent_binding, "consent-binding-unknown");
	const afterReload = await beginConsent(reloaded, cwd);
	assert.notEqual(afterReload.consent_binding, third.consent_binding);
	assert.equal(fixture.starts.count, 5);
});

test("native START maps only provider facts and omits absent evidence", async (t) => {
	const cwd = repository(t);
	const nextTransition = {
		kind: "execute" as const,
		reasonCode: "review_status_required",
		execute: {
			operation: "review.status",
			arguments: [{ name: "lineage", value: "closed-lineage", token: "--lineage=closed-lineage" }],
			preconditions: [],
			binding: { targetIdentity: `sha256:${"d".repeat(64)}` },
		},
	};
	const native = {
		targetStatus: async () => startStatus(cwd),
		start: async () => ({
			lineageId: "closed-lineage",
			state: "approved",
			riskLevel: "low",
			selectedLenses: [],
			changedFiles: 0,
			changedLines: 0,
			correctionBudget: 0,
			action: "closed",
			lensesRequired: false,
			riskReasons: [],
			nextTransition,
			hint: "provider empty-candidate hint",
		}),
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, native);
	const rendered = result.result as Record<string, unknown>;
	assert.equal(rendered.hint, "provider empty-candidate hint");
	assert.equal(rendered.risk_evidence, undefined);
	assert.equal(rendered.next_transition, nextTransition);
});

test("candidate consent completion writes no persistent asked latch", async (t) => {
	const cwd = repository(t);
	const fixture = consentNative(cwd);
	const runtime = parityRuntime(fixture.native);
	const blocked = await beginConsent(runtime, cwd);
	const completed = await answerConsent(runtime, cwd, blocked.consent_binding, "granted");
	assert.equal((completed.result as { lineage_id?: string }).lineage_id, "consent-lineage");
	assert.deepEqual(fixture.answers, ["granted"]);
	const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
	assert.equal(existsSync(join(commonDir, "gentle-pi", "review-consent", "asked.json")), false);
});
