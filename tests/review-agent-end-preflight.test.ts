import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { NATIVE_REVIEW_ERROR_CODE, NativeReviewCliError, type NativeReviewCli } from "../lib/native-review-cli.ts";
import type { ReviewStatusV3 } from "../lib/review-integration-v2.ts";

// gentle-pi#556 / gentle-ai#4051: with RDD enabled, the agent finished an
// implementation and reported completion without ever entering the review
// preflight. These tests cover the read-only, idempotent `agent_end` nudge
// that reminds the agent to call gentle_review before reporting completion,
// without ever starting a review or answering consent itself.
//
// gentle-pi#568/#777: startup negotiates STATUS, but only successful own
// mutation receipts authorize agent_end to query a candidate. Pre-session
// work and foreign-session changes are not this session's output. These tests point
// `GENTLE_PI_AGENT_HOME` and the session `cwd` at fresh temp directories so
// `session_start`'s real SDD asset install and model config sweep never
// touch this machine's actual home directory. The cwd is an isolated Git
// fixture so mutation receipts exercise canonical root resolution.

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
type SentMessage = { message: Record<string, unknown>; options: Record<string, unknown> };

type CustomEntry = { type: string; customType: string; data: unknown };
function harness(nativeReviewCli: NativeReviewCli | null, entries: CustomEntry[] = []): {
	handlers: Map<string, AnyHandler>;
	sent: SentMessage[];
	tools: Map<string, RegisteredTool>;
} {
	const handlers = new Map<string, AnyHandler>();
	const sent: SentMessage[] = [];
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		on(name: string, handler: AnyHandler) {
			handlers.set(name, (event, context) => {
				context.sessionManager.getBranch ??= (() => entries) as typeof context.sessionManager.getBranch;
				return handler(event, context);
			});
		},
		events: { emit() {} },
		registerCommand() {},
		registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
		sendMessage(message: Record<string, unknown>, options: Record<string, unknown> = {}) {
			sent.push({ message, options });
		},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli })(pi);
	return { handlers, sent, tools };
}

function ctx(sessionId: string, hasUI = true, cwd = process.cwd()): ExtensionContext {
	return {
		cwd,
		hasUI,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;
}

async function withSessionStartEnv<T>(callback: (cwd: string) => Promise<T>): Promise<T> {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-session-baseline-agent-home-"));
	// Isolates both the model-config sweep and the dev-binary registration
	// lookup from this machine's real ~/.pi/gentle-ai, so `session_start`'s
	// unrelated notifications never leak into these assertions.
	process.env.GENTLE_PI_CONFIG_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-session-baseline-config-home-"));
	try {
		const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-session-baseline-cwd-"));
		childProcess.execFileSync("git", ["init", "--quiet", cwd]);
		await mkdir(join(cwd, "src"));
		await writeFile(join(cwd, "src/example.ts"), "export const value = 1;");
		return await callback(cwd);
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
	}
}

function onMode(effective: "on" | "off"): NativeReviewCli["reviewMode"] {
	return async () => ({
		operation: "status",
		scope: "clone",
		status: { global: "", cloneLocal: effective === "on" ? "on" : "", effective, source: "clone_local" },
	});
}

function executeStartStatus(targetIdentity: string): ReviewStatusV3 {
	return {
		applicability: "unrelated",
		action: "start",
		targetIdentity,
		nextTransition: { kind: "execute", execute: { operation: "review.start", arguments: [] } },
	} as unknown as ReviewStatusV3;
}

function collectStatus(targetIdentity: string): ReviewStatusV3 {
	return {
		applicability: "unrelated",
		action: "start",
		targetIdentity,
		nextTransition: { kind: "collect", collect: { inputs: [] } },
	} as unknown as ReviewStatusV3;
}

function stopStatus(targetIdentity: string): ReviewStatusV3 {
	return {
		applicability: "unrelated",
		action: "start",
		targetIdentity,
		nextTransition: { kind: "stop" },
	} as unknown as ReviewStatusV3;
}

const agentEndEvent = { type: "agent_end", messages: [] };
let mutationCall = 0;
async function directWrite(handlers: Map<string, AnyHandler>, session: ExtensionContext): Promise<void> {
	await handlers.get("tool_result")!({ type: "tool_result", toolName: "write", toolCallId: `own-${++mutationCall}`,
		input: { path: session.cwd === process.cwd() || session.cwd === realpathSync(process.cwd()) ? "tests/review-agent-end-preflight.test.ts" : "src/example.ts" },
		content: [], isError: false }, session);
}

// #772: use the acknowledgement vector and returned-envelope shapes from
// review-controller-native-routing.test.ts, through the registered tool rather
// than the controller helper, so agent_end shares the same extension state.
for (const scenario of ["same", "changed", "sibling-root", "nested-root", "failed", "unknown", "shutdown", "other-session", "legacy-success", "new-write", "concurrent-write"] as const) {
	test(`agent_end after approved acknowledgement: ${scenario}`, async (t) => {
		const changedTarget = scenario === "changed";
		const unsuccessful = scenario === "failed" || scenario === "unknown";
		const cwd = realpathSync(process.cwd());
		const siblingRoot = realpathSync(tmpdir());
		if (scenario === "sibling-root") {
			// Model a sibling worktree sharing the real common directory without
			// creating a worktree or mutating repository state.
			const exec = childProcess.execFileSync;
			const commonDir = exec("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
			t.mock.method(childProcess, "execFileSync", (file: string, args: string[], options: { cwd?: string }) => {
				if (file === "git" && options.cwd === siblingRoot) {
					if (args[1] === "--show-toplevel") return siblingRoot;
					if (args[1] === "--git-common-dir") return commonDir;
				}
				return exec(file, args, options);
			});
			syncBuiltinESMExports();
			t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		}
		const lineageId = `agent-end-post-ack-${scenario}`;
		const targetIdentity = `sha256:${"a".repeat(64)}`;
		const nextTarget = changedTarget ? `sha256:${"b".repeat(64)}` : targetIdentity;
		const binding = { lineageId, targetIdentity, revision: targetIdentity };
		const arguments_ = [
			["cwd", cwd], ["lineage", lineageId], ["target", targetIdentity],
			["expected-revision", targetIdentity], ["token", "provider-issued-once"],
		].map(([name, value]) => ({ name, value, token: `--${name}=${value}` }));
		const approved = {
			contract: "gentle-ai.review-integration/v2",
			applicability: "current_target",
			authority: { version: "compact-v2", lineageId, state: "approved", generation: 1, revision: targetIdentity },
			receipt: { status: "expected_missing" },
			action: "stop", replayability: "not_replayable", targetIdentity, candidates: [],
			nextTransition: {
				kind: "execute", reasonCode: "approved_acknowledgement_required",
				execute: {
					operation: "review.acknowledge-approved",
					command: "gentle-ai review acknowledge-approved --provider-vector",
					arguments: arguments_,
					preconditions: [{ name: "state", value: "approved", token: "--state=approved" }],
					binding,
				},
			},
			raw: { schema: "gentle-ai.review-integration.status/v5" },
		} as unknown as ReviewStatusV3;
		const statusRequests: unknown[] = [];
		const acknowledgementRequests: unknown[] = [];
		let burned = false;
		const native = {
			reviewMode: onMode("on"),
			targetStatus: async (request: unknown) => {
				statusRequests.push(request);
				return burned ? executeStartStatus(nextTarget) : approved;
			},
			acknowledgeApproved: async (request: unknown) => {
				acknowledgementRequests.push(request);
				if (scenario === "concurrent-write") await directWrite(handlers, session);
				burned = true;
				if (scenario === "failed") throw new TypeError("local acknowledgement validation failed");
				if (scenario === "unknown") throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, "review/acknowledge-approved", true, true, "acknowledgement outcome unknown");
				if (scenario === "legacy-success") return undefined;
				return {
					schema: "gentle-ai.review-acknowledged/v1",
					operation: "review/acknowledge-approved", action: "acknowledged",
					lineageId, targetIdentity, consumedRevision: targetIdentity, authority: "burned",
					raw: { schema: "gentle-ai.review-acknowledged/v1" },
				};
			},
		} as unknown as NativeReviewCli;
		const { handlers, sent, tools } = harness(native);
		const session = ctx(lineageId, true, cwd);
		const review = tools.get("gentle_review");
		assert.ok(review);
		await directWrite(handlers, session);
		const result = await review.execute("post-ack", { operation: "acknowledge-approved", lineageId }, undefined, undefined, session);
		if (unsuccessful) {
			assert.equal(result.details.outcome, scenario === "failed" ? "native-operation-failed" : "native-mutation-status-reconciled");
			assert.equal(result.details.mutation_outcome, scenario === "failed" ? "none" : "unknown");
		} else assert.deepEqual(result.details, {
			operation: "acknowledge-approved", status: "closed",
			outcome: "native-approved-acknowledgement-completed",
			lineage_id: lineageId, target_identity: targetIdentity,
			...(scenario === "legacy-success" ? {} : { consumed_revision: targetIdentity, burn_evidence: "gentle-ai.review-acknowledged/v1" }),
			authority: "burned",
			delivery: "ordinary-repository-policy", mutation_performed: true, mutation_outcome: "committed",
		});
		assert.deepEqual(acknowledgementRequests, [{ cwd, argumentTokens: arguments_.map(({ token }) => token), binding }]);
		if (scenario !== "unknown") assert.deepEqual(statusRequests, [{ cwd, lineageId }], "ACK reports burn without a later STATUS");
		const callsBeforeEnd = statusRequests.length;
		assert.deepEqual(sent, [], "no earlier reminder can mask the post-burn regression");

		if (scenario === "shutdown") await handlers.get("session_shutdown")!({}, session);
		const endSession = scenario === "sibling-root" ? ctx(lineageId, true, siblingRoot)
			: scenario === "nested-root" ? ctx(lineageId, true, join(cwd, "tests"))
			: scenario === "other-session" ? ctx(`${lineageId}-new`, true, cwd) : session;
		if (changedTarget || scenario === "new-write") await directWrite(handlers, endSession);
		await handlers.get("agent_end")!(agentEndEvent, endSession);
		const shouldRemind = changedTarget || unsuccessful || scenario === "new-write" || scenario === "concurrent-write";
		assert.deepEqual(statusRequests.slice(callsBeforeEnd), shouldRemind ? [{ cwd: endSession.cwd, agent: "pi" }] : []);
		const reminders = sent.filter(({ message }) => message.customType === "gentle-pi.review-preflight");
		assert.equal(reminders.length, shouldRemind ? 1 : 0,
			shouldRemind ? "an unconsumed own mutation still requires preflight" : "an acknowledged or unowned target must not receive another preflight reminder");
		if (changedTarget) assert.ok(String(reminders[0]?.message.content).includes(nextTarget));
	});
}

test("agent_end performs no STATUS call and sends nothing when RDD is off", async () => {
	const statusRequests: unknown[] = [];
	const native = {
		reviewMode: onMode("off"),
		targetStatus: async (request: unknown) => {
			statusRequests.push(request);
			throw new Error("targetStatus must not be called when RDD is off");
		},
	} as unknown as NativeReviewCli;
	const { handlers, sent } = harness(native);
	const agentEnd = handlers.get("agent_end");
	assert.equal(typeof agentEnd, "function");
	await agentEnd!(agentEndEvent, ctx("agent-end-rdd-off"));
	assert.deepEqual(statusRequests, []);
	assert.deepEqual(sent, []);
});

test("agent_end nudges exactly once when RDD is on and STATUS offers review.start", async () => {
	const targetIdentity = `sha256:${"a".repeat(64)}`;
	const statusRequests: Array<{ agent?: string }> = [];
	const native = {
		reviewMode: onMode("on"),
		targetStatus: async (request: { agent?: string }) => {
			statusRequests.push(request);
			return executeStartStatus(targetIdentity);
		},
	} as unknown as NativeReviewCli;
	const { handlers, sent } = harness(native);
	const agentEnd = handlers.get("agent_end");
	const session = ctx("agent-end-execute");
	await directWrite(handlers, session);
	await agentEnd!(agentEndEvent, session);

	assert.equal(sent.length, 1);
	const [entry] = sent;
	assert.equal(entry?.message.customType, "gentle-pi.review-preflight");
	const content = String(entry?.message.content);
	assert.match(content, /gentle_review/);
	assert.match(content, /first determine whether the user explicitly left this exact target unreviewed\. if yes, do not invoke review; report that disposition and continue\. only otherwise, call the gentle_review tool with \{"operation":"inspect"\}/i);
	assert.doesNotMatch(content, /run the review preflight before reporting completion\. if the user explicitly left/i);
	assert.ok(content.includes(targetIdentity), "message must name the target identity");
	assert.equal(entry?.options.triggerTurn, true);
	assert.equal(statusRequests[0]?.agent, "pi");
});

test("agent_end nudges once per target identity and again for a fresh identity", async () => {
	let targetIdentity = `sha256:${"b".repeat(64)}`;
	const native = {
		reviewMode: onMode("on"),
		targetStatus: async () => executeStartStatus(targetIdentity),
	} as unknown as NativeReviewCli;
	const { handlers, sent } = harness(native);
	const agentEnd = handlers.get("agent_end");
	const session = ctx("agent-end-repeat");
	await directWrite(handlers, session);

	await agentEnd!(agentEndEvent, session);
	await agentEnd!(agentEndEvent, session);
	assert.equal(sent.length, 1, "the same target identity nudges only once");

	targetIdentity = `sha256:${"e".repeat(64)}`;
	await directWrite(handlers, session);
	await agentEnd!(agentEndEvent, session);
	assert.equal(sent.length, 2, "a different target identity nudges again");
});

test("agent_end sends nothing when STATUS offers collect or stop", async () => {
	for (const [label, status] of [
		["collect", collectStatus(`sha256:${"c".repeat(64)}`)],
		["stop", stopStatus(`sha256:${"d".repeat(64)}`)],
	] as const) {
		const native = {
			reviewMode: onMode("on"),
			targetStatus: async () => status,
		} as unknown as NativeReviewCli;
		const { handlers, sent } = harness(native);
		const agentEnd = handlers.get("agent_end");
		const session = ctx(`agent-end-${label}`);
		await directWrite(handlers, session);
		await agentEnd!(agentEndEvent, session);
		assert.deepEqual(sent, [], label);
	}
});

test("agent_end skips headless sessions before any native call", async () => {
	const native = {
		reviewMode: async () => {
			throw new Error("reviewMode must not be called when hasUI is false");
		},
		targetStatus: async () => {
			throw new Error("targetStatus must not be called when hasUI is false");
		},
	} as unknown as NativeReviewCli;
	const { handlers, sent } = harness(native);
	const agentEnd = handlers.get("agent_end");
	await agentEnd!(agentEndEvent, ctx("agent-end-no-ui", false));
	assert.deepEqual(sent, []);
});

test("agent_end pairs a named agent's start with its own end, then still nudges for the primary loop's end", async () => {
	const targetIdentity = `sha256:${"f".repeat(64)}`;
	const native = {
		reviewMode: onMode("on"),
		targetStatus: async () => executeStartStatus(targetIdentity),
	} as unknown as NativeReviewCli;
	const { handlers, sent } = harness(native);
	const beforeAgentStart = handlers.get("before_agent_start");
	const agentEnd = handlers.get("agent_end");
	assert.equal(typeof beforeAgentStart, "function");
	const session = ctx("agent-end-subagent");
	await directWrite(handlers, session);

	await beforeAgentStart!({ agentName: "review-readability", systemPrompt: "" }, session);
	await agentEnd!(agentEndEvent, session);
	assert.deepEqual(sent, [], "the subagent's own loop end is suppressed");

	await agentEnd!(agentEndEvent, session);
	assert.equal(sent.length, 1, "the primary loop's end still nudges once the subagent's end is paired off");
});

test("gentle-ai-worker agent_end never queries native review", async () => {
	const statusRequests: unknown[] = [];
	const native = {
		reviewMode: onMode("on"),
		targetStatus: async (request: unknown) => {
			statusRequests.push(request);
			throw new Error("a bounded worker must not own native review");
		},
	} as unknown as NativeReviewCli;
	const { handlers, sent } = harness(native);
	const beforeAgentStart = handlers.get("before_agent_start");
	const agentEnd = handlers.get("agent_end");
	const session = ctx("agent-end-generic-worker");
	assert.equal(typeof beforeAgentStart, "function");
	await beforeAgentStart!({ agentName: "gentle-ai-worker", systemPrompt: "" }, session);
	await directWrite(handlers, session);
	await agentEnd!(agentEndEvent, session);
	assert.deepEqual(statusRequests, []);
	assert.deepEqual(sent, []);
});

test("agent_end resets the subagent depth when a fresh primary loop starts", async () => {
	const targetIdentity = `sha256:${"1".repeat(64)}`;
	const native = {
		reviewMode: onMode("on"),
		targetStatus: async () => executeStartStatus(targetIdentity),
	} as unknown as NativeReviewCli;
	const { handlers, sent } = harness(native);
	const beforeAgentStart = handlers.get("before_agent_start");
	const agentEnd = handlers.get("agent_end");
	const session = ctx("agent-end-subagent-reset");
	await directWrite(handlers, session);

	await beforeAgentStart!({ agentName: "review-readability", systemPrompt: "" }, session);
	await beforeAgentStart!({ systemPrompt: "" }, session);
	await agentEnd!(agentEndEvent, session);

	assert.equal(sent.length, 1, "a fresh primary-loop start resets the depth so its own end nudges");
});

test("agent_end handler exists but sends nothing when nativeReviewCli is null", async () => {
	const { handlers, sent } = harness(null);
	const agentEnd = handlers.get("agent_end");
	assert.equal(typeof agentEnd, "function");
	await agentEnd!(agentEndEvent, ctx("agent-end-null-cli"));
	assert.deepEqual(sent, []);
});

test("agent_end sends nothing and does not throw when target STATUS rejects", async () => {
	const native = {
		reviewMode: onMode("on"),
		targetStatus: async () => {
			throw new Error("native status unavailable");
		},
	} as unknown as NativeReviewCli;
	const { handlers, sent } = harness(native);
	const agentEnd = handlers.get("agent_end");
	const session = ctx("agent-end-status-throws");
	await directWrite(handlers, session);
	await assert.doesNotReject(async () => agentEnd!(agentEndEvent, session));
	assert.deepEqual(sent, []);
});

test("session_shutdown ignores late agent_end after a consumed mutation", async () => {
	const targetIdentity = `sha256:${"9".repeat(64)}`;
	const native = {
		reviewMode: onMode("on"),
		targetStatus: async () => executeStartStatus(targetIdentity),
	} as unknown as NativeReviewCli;
	const { handlers, sent } = harness(native);
	const agentEnd = handlers.get("agent_end");
	const shutdown = handlers.get("session_shutdown");
	assert.equal(typeof shutdown, "function");
	const session = ctx("agent-end-shutdown");
	await directWrite(handlers, session);

	await agentEnd!(agentEndEvent, session);
	assert.equal(sent.length, 1);

	await shutdown!({}, session);
	await agentEnd!(agentEndEvent, session);
	assert.equal(sent.length, 1, "late agent_end after shutdown cannot remind");
});

for (const scenario of ["reload", "fork", "new", "off-branch"] as const) {
	test(`agent_end restores pending receipts only for the active session branch: ${scenario}`, async () => {
		await withSessionStartEnv(async (cwd) => {
			const entries: CustomEntry[] = [];
			let statusCalls = 0;
			const native = { reviewMode: onMode("on"), targetStatus: async () => { statusCalls += 1; return executeStartStatus("whole-target"); } } as unknown as NativeReviewCli;
			const first = harness(native, entries);
			const session = ctx(`receipt-${scenario}`, true, cwd);
			await first.handlers.get("session_start")!({}, session);
			await directWrite(first.handlers, session);
			await first.handlers.get("session_shutdown")!({ reason: "reload" }, session);
			const resumed = harness(native, entries);
			const next = ctx(scenario === "reload" || scenario === "off-branch" ? `receipt-${scenario}` : `replacement-${scenario}`, true, cwd);
			if (scenario === "off-branch") next.sessionManager.getBranch = () => [];
			await resumed.handlers.get("session_start")!({ reason: scenario }, next);
			const beforeEnd = statusCalls;
			await resumed.handlers.get("agent_end")!(agentEndEvent, next);
			assert.equal(statusCalls - beforeEnd, scenario === "reload" ? 1 : 0);
			assert.equal(resumed.sent.length, scenario === "reload" ? 1 : 0);
		});
	});
}

for (const scenario of ["concurrent-write", "shutdown"] as const) {
	test(`agent_end binds consumption to the captured mutation during async STATUS: ${scenario}`, async () => {
		const session = ctx(`status-race-${scenario}`);
		let resolveStatus!: (status: ReviewStatusV3) => void;
		let entered!: () => void;
		const statusEntered = new Promise<void>((resolve) => { entered = resolve; });
		let calls = 0;
		const native = { reviewMode: onMode("on"), targetStatus: async () => {
			calls += 1;
			if (calls > 1) return executeStartStatus("next-whole-target");
			entered();
			return new Promise<ReviewStatusV3>((resolve) => { resolveStatus = resolve; });
		} } as unknown as NativeReviewCli;
		const h = harness(native);
		await directWrite(h.handlers, session);
		const ending = h.handlers.get("agent_end")!(agentEndEvent, session);
		await statusEntered;
		if (scenario === "shutdown") await h.handlers.get("session_shutdown")!({}, session);
		await directWrite(h.handlers, session);
		resolveStatus(executeStartStatus("captured-whole-target"));
		await ending;
		await h.handlers.get("agent_end")!(agentEndEvent, session);
		assert.equal(h.sent.length, scenario === "concurrent-write" ? 2 : 0);
		assert.equal(calls, scenario === "concurrent-write" ? 2 : 1);
	});
}

test("successful direct writes in another canonical root do not authorize this root's reminder", async () => {
	await withSessionStartEnv(async (otherRoot) => {
		let statusCalls = 0;
		const h = harness({ reviewMode: onMode("on"), targetStatus: async () => { statusCalls += 1; return executeStartStatus("foreign"); } } as unknown as NativeReviewCli);
		const session = ctx("direct-other-root");
		await h.handlers.get("tool_result")!({ type: "tool_result", toolName: "write", toolCallId: "other-root", input: { path: join(otherRoot, "src/example.ts") }, isError: false, content: [] }, session);
		await h.handlers.get("agent_end")!(agentEndEvent, session);
		assert.equal(statusCalls, 0);
		assert.deepEqual(h.sent, []);
	});
});

for (const toolName of ["read", "bash", "subagent_run", "edit", "write"]) {
	test(`unsuccessful or non-mutating direct ${toolName} never authorizes shared STATUS`, async () => {
		let statusCalls = 0;
		const h = harness({ reviewMode: onMode("on"), targetStatus: async () => { statusCalls += 1; return executeStartStatus("foreign"); } } as unknown as NativeReviewCli);
		const session = ctx(`rejected-${toolName}`);
		await h.handlers.get("tool_result")!({ type: "tool_result", toolName, toolCallId: "rejected", input: { path: "tests/review-agent-end-preflight.test.ts" }, isError: toolName === "write" || toolName === "edit", content: [] }, session);
		await h.handlers.get("agent_end")!(agentEndEvent, session);
		assert.equal(statusCalls, 0);
		assert.deepEqual(h.sent, []);
	});
}

test("session_start negotiates the current target identity when RDD is on", async () => {
	const targetIdentity = `sha256:${"2".repeat(64)}`;
	const statusRequests: Array<{ agent?: string }> = [];
	const native = {
		reviewMode: onMode("on"),
		targetStatus: async (request: { agent?: string }) => {
			statusRequests.push(request);
			return executeStartStatus(targetIdentity);
		},
	} as unknown as NativeReviewCli;
	await withSessionStartEnv(async (cwd) => {
		const { handlers, sent } = harness(native);
		const sessionStart = handlers.get("session_start");
		assert.equal(typeof sessionStart, "function");
		const notifications: Array<{ message: string; severity: string }> = [];
		const session = {
			...ctx("session-baseline-record", true, cwd),
			ui: { notify: (message: string, severity: string) => notifications.push({ message, severity }) },
		};
		await sessionStart!({}, session);
		assert.equal(statusRequests[0]?.agent, "pi");
		assert.deepEqual(sent, []);
		assert.deepEqual(notifications, []);
	});
});

test("agent_end skips pre-session work, then nudges after an own mutation", async () => {
	let targetIdentity = `sha256:${"3".repeat(64)}`;
	const native = {
		reviewMode: onMode("on"),
		targetStatus: async () => executeStartStatus(targetIdentity),
	} as unknown as NativeReviewCli;
	await withSessionStartEnv(async (cwd) => {
		const { handlers, sent } = harness(native);
		const sessionStart = handlers.get("session_start");
		const agentEnd = handlers.get("agent_end");
		const session = ctx("session-baseline-skip", true, cwd);

		await sessionStart!({}, session);
		await agentEnd!(agentEndEvent, session);
		assert.deepEqual(sent, [], "the baseline candidate predates the session and is not nudged");

		targetIdentity = `sha256:${"4".repeat(64)}`;
		await directWrite(handlers, session);
		await agentEnd!(agentEndEvent, session);
		assert.equal(sent.length, 1, "a candidate identity different from the baseline still nudges");
	});
});

// #777: a shared worktree's changed target is not evidence that this session
// mutated it. Exercise real registered handlers; all native operations are mocks.
for (const ownsMutation of [false, true]) {
	test(ownsMutation
		? "agent_end still checks and reminds after this session's successful direct write"
		: "agent_end ignores a foreign session's changed target after read-only work", async () => {
		const targetA = `sha256:${"a".repeat(64)}`;
		const targetB = `sha256:${"b".repeat(64)}`;
		let targetIdentity = targetA;
		const statusRequests: unknown[] = [];
		const native = {
			reviewMode: onMode("on"),
			targetStatus: async (request: unknown) => {
				statusRequests.push(request);
				return executeStartStatus(targetIdentity);
			},
		} as unknown as NativeReviewCli;
		await withSessionStartEnv(async (cwd) => {
			const { handlers, sent } = harness(native);
			const session = ctx(`session-777-${ownsMutation ? "direct-write" : "read-only"}`, true, cwd);
			const sessionStart = handlers.get("session_start");
			const toolResult = handlers.get("tool_result");
			const agentEnd = handlers.get("agent_end");
			assert.equal(typeof sessionStart, "function");
			assert.equal(typeof agentEnd, "function");

			await sessionStart!({}, session);
			assert.deepEqual(statusRequests, [{ cwd, agent: "pi" }], "startup records targetA separately");
			assert.deepEqual(sent, []);
			// Like host event delivery, an event without a subscriber is a no-op.
			await toolResult?.({
				type: "tool_result", toolName: "read", toolCallId: "777-read",
				input: { path: "src/example.ts" },
				content: [{ type: "text", text: "export const value = 1;" }],
				isError: false,
			}, session);
			if (ownsMutation) {
				await toolResult?.({
					type: "tool_result", toolName: "write", toolCallId: "777-write",
					input: { path: "src/example.ts", content: "export const value = 2;" },
					content: [{ type: "text", text: "Successfully wrote src/example.ts" }],
					isError: false,
				}, session);
			}
			// In the read-only case, only foreign session B changes the shared
			// candidate. No successful mutation event is delivered to session A.
			// In the positive control, the direct write above owns the change.
			targetIdentity = targetB;
			const callsBeforeEnd = statusRequests.length;
			await agentEnd!(agentEndEvent, session);
			const reminders = sent.filter(({ message }) => message.customType === "gentle-pi.review-preflight");
			assert.deepEqual({
				statusRequests: statusRequests.slice(callsBeforeEnd),
				reminderCount: reminders.length,
			}, ownsMutation ? {
				statusRequests: [{ cwd, agent: "pi" }], reminderCount: 1,
			} : {
				statusRequests: [], reminderCount: 0,
			}, ownsMutation
				? "a successful direct write must retain native preflight and its reminder"
				: "read-only session A must neither query shared STATUS nor remind for session B's target");
			if (ownsMutation) assert.ok(String(reminders[0]?.message.content).includes(targetB));
		});
	});
}

test("agent_end reminds for an own write after startup with RDD off", async () => {
	const targetIdentity = `sha256:${"5".repeat(64)}`;
	let mode: "on" | "off" = "off";
	const statusRequests: unknown[] = [];
	const native = {
		reviewMode: async () => ({
			operation: "status",
			scope: "clone",
			status: { global: "", cloneLocal: mode === "on" ? "on" : "", effective: mode, source: "clone_local" },
		}),
		targetStatus: async (request: unknown) => {
			statusRequests.push(request);
			if (mode === "off") throw new Error("targetStatus must not be called when RDD is off");
			return executeStartStatus(targetIdentity);
		},
	} as unknown as NativeReviewCli;
	await withSessionStartEnv(async (cwd) => {
		const { handlers, sent } = harness(native);
		const sessionStart = handlers.get("session_start");
		const agentEnd = handlers.get("agent_end");
		const session = ctx("session-baseline-rdd-off", true, cwd);

		await sessionStart!({}, session);
		assert.deepEqual(statusRequests, []);

		mode = "on";
		await directWrite(handlers, session);
		await agentEnd!(agentEndEvent, session);
		assert.equal(sent.length, 1, "startup with RDD off does not prevent an own-write reminder after RDD is enabled");
	});
});

test("agent_end reminds for an own write after startup STATUS rejects", async () => {
	const targetIdentity = `sha256:${"6".repeat(64)}`;
	let shouldThrow = true;
	const native = {
		reviewMode: onMode("on"),
		targetStatus: async () => {
			if (shouldThrow) throw new Error("native status unavailable at session start");
			return executeStartStatus(targetIdentity);
		},
	} as unknown as NativeReviewCli;
	await withSessionStartEnv(async (cwd) => {
		const { handlers, sent } = harness(native);
		const sessionStart = handlers.get("session_start");
		const agentEnd = handlers.get("agent_end");
		const session = ctx("session-baseline-throws", true, cwd);

		await assert.doesNotReject(async () => sessionStart!({}, session));

		shouldThrow = false;
		await directWrite(handlers, session);
		await agentEnd!(agentEndEvent, session);
		assert.equal(sent.length, 1, "startup STATUS failure does not prevent a subsequent own-write reminder");
	});
});

test("session_shutdown does not turn the baseline into an own mutation", async () => {
	const targetIdentity = `sha256:${"7".repeat(64)}`;
	const native = {
		reviewMode: onMode("on"),
		targetStatus: async () => executeStartStatus(targetIdentity),
	} as unknown as NativeReviewCli;
	await withSessionStartEnv(async (cwd) => {
		const { handlers, sent } = harness(native);
		const sessionStart = handlers.get("session_start");
		const agentEnd = handlers.get("agent_end");
		const shutdown = handlers.get("session_shutdown");
		const session = ctx("session-baseline-shutdown", true, cwd);

		await sessionStart!({}, session);
		await agentEnd!(agentEndEvent, session);
		assert.deepEqual(sent, [], "the baseline candidate is skipped");

		await shutdown!({}, session);
		await agentEnd!(agentEndEvent, session);
		assert.equal(sent.length, 0, "shutdown never turns a foreign baseline into an own mutation");
	});
});
