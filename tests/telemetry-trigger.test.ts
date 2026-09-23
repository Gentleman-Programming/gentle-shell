import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { __testing, createGentleAiExtension } from "../extensions/gentle-ai.ts";
import type { ExecFileAdapter, ExecFileResult } from "../lib/native-review-cli.ts";
import {
	decodeTelemetryTriggerDecision,
	shouldTriggerTelemetry,
	spawnTelemetryTrigger,
	TELEMETRY_TRIGGER_CONTRACT,
	TELEMETRY_TRIGGER_KILL_TIMEOUT_MS,
	type TelemetryTriggerChildLike,
	type TelemetryTriggerSpawn,
	type TelemetryTriggerSpawnOptions,
} from "../lib/telemetry-trigger.ts";

// ---------------------------------------------------------------------------
// gentle-pi#677: gentle-ai owns telemetry end to end (gentle-ai#4309); Pi only
// nudges the local binary once per process. These tests cover the pure
// predicate/spawn/decode core in lib/telemetry-trigger.ts and the two ways
// extensions/gentle-ai.ts wires it in: the once-per-process activation nudge
// and the foreground /gentle:telemetry slash command relay.
// ---------------------------------------------------------------------------

interface FakeSpawnRecord {
	command: string;
	args: string[];
	options: TelemetryTriggerSpawnOptions;
}

function fakeSpawn(): { spawn: TelemetryTriggerSpawn; calls: FakeSpawnRecord[]; killCalls: number } {
	const calls: FakeSpawnRecord[] = [];
	const state = { killCalls: 0 };
	const spawn: TelemetryTriggerSpawn = (command, args, options) => {
		calls.push({ command, args: [...args], options });
		const child: TelemetryTriggerChildLike = {
			unref() {
				return undefined;
			},
			kill() {
				state.killCalls += 1;
				return true;
			},
			on() {
				return undefined;
			},
		};
		return child;
	};
	return {
		spawn,
		calls,
		get killCalls() {
			return state.killCalls;
		},
	};
}

test("shouldTriggerTelemetry: pure predicate table", () => {
	const cases: Array<[Record<string, string | undefined>, boolean]> = [
		[{}, true],
		[{ DO_NOT_TRACK: "1" }, false],
		[{ DO_NOT_TRACK: "0" }, true],
		[{ GENTLE_AI_TELEMETRY: "0" }, false],
		[{ GENTLE_AI_TELEMETRY: "1" }, true],
		[{ CI: "true" }, false],
		[{ CI: "false" }, true],
		[{ CI: undefined }, true],
		[{ DO_NOT_TRACK: "1", GENTLE_AI_TELEMETRY: "0", CI: "true" }, false],
	];
	for (const [env, expected] of cases) {
		assert.equal(shouldTriggerTelemetry(env), expected, JSON.stringify(env));
	}
});

test("spawnTelemetryTrigger: launches the expected argv, detached, hidden, and stdio-ignored", () => {
	const fake = fakeSpawn();
	const result = spawnTelemetryTrigger({
		executable: "/opt/gentle-ai/gentle-ai",
		cwd: "/work/project",
		env: {},
		spawn: fake.spawn,
	});
	assert.deepEqual(result, { spawned: true, reason: "spawned" });
	assert.equal(fake.calls.length, 1);
	const [call] = fake.calls;
	assert.equal(call.command, "/opt/gentle-ai/gentle-ai");
	assert.deepEqual(call.args, ["telemetry", "trigger", "--json"]);
	assert.equal(call.options.cwd, "/work/project");
	assert.equal(call.options.detached, true);
	assert.equal(call.options.windowsHide, true);
	assert.equal(call.options.stdio, "ignore");
});

test("spawnTelemetryTrigger: never spawns under each kill switch", () => {
	const switches: Array<[Record<string, string | undefined>, string]> = [
		[{ DO_NOT_TRACK: "1" }, "do-not-track"],
		[{ GENTLE_AI_TELEMETRY: "0" }, "telemetry-disabled"],
		[{ CI: "true" }, "ci"],
	];
	for (const [env, reason] of switches) {
		const fake = fakeSpawn();
		const result = spawnTelemetryTrigger({ executable: "gentle-ai", cwd: "/work", env, spawn: fake.spawn });
		assert.deepEqual(result, { spawned: false, reason }, JSON.stringify(env));
		assert.equal(fake.calls.length, 0, JSON.stringify(env));
	}
});

test("spawnTelemetryTrigger: a throwing spawn is swallowed, never thrown", () => {
	const throwingSpawn: TelemetryTriggerSpawn = () => {
		throw new Error("spawn EAGAIN");
	};
	const result = spawnTelemetryTrigger({ executable: "gentle-ai", cwd: "/work", env: {}, spawn: throwingSpawn });
	assert.deepEqual(result, { spawned: false, reason: "spawn-error" });
});

test("spawnTelemetryTrigger: the 3 s kill timer fires exactly once and is unref'd", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const fake = fakeSpawn();
	const result = spawnTelemetryTrigger({ executable: "gentle-ai", cwd: "/work", env: {}, spawn: fake.spawn });
	assert.equal(result.spawned, true);
	assert.equal(fake.killCalls, 0);
	t.mock.timers.tick(TELEMETRY_TRIGGER_KILL_TIMEOUT_MS);
	assert.equal(fake.killCalls, 1);
	t.mock.timers.tick(TELEMETRY_TRIGGER_KILL_TIMEOUT_MS);
	assert.equal(fake.killCalls, 1, "the timer must not fire a second time");
});

test("decodeTelemetryTriggerDecision: decodes a well-formed v1 payload", () => {
	const stdout = JSON.stringify({ schema: TELEMETRY_TRIGGER_CONTRACT, decision: "sent_heartbeat", source: "local-state" });
	assert.deepEqual(decodeTelemetryTriggerDecision(stdout), {
		schema: TELEMETRY_TRIGGER_CONTRACT,
		decision: "sent_heartbeat",
		source: "local-state",
	});
});

test("decodeTelemetryTriggerDecision: every documented decision round-trips", () => {
	for (const decision of ["enrolled", "sent_install", "sent_heartbeat", "rate_limited", "backoff", "disabled"]) {
		const stdout = JSON.stringify({ schema: TELEMETRY_TRIGGER_CONTRACT, decision, source: "env" });
		assert.equal(decodeTelemetryTriggerDecision(stdout)?.decision, decision);
	}
});

test("decodeTelemetryTriggerDecision: an old binary's output decodes as nothing to do", () => {
	assert.equal(decodeTelemetryTriggerDecision("unknown telemetry command\n"), undefined);
	assert.equal(decodeTelemetryTriggerDecision(""), undefined);
});

test("decodeTelemetryTriggerDecision: rejects a mismatched schema, unknown decision, or missing source", () => {
	assert.equal(decodeTelemetryTriggerDecision(JSON.stringify({ schema: "other/v1", decision: "enrolled", source: "cli" })), undefined);
	assert.equal(decodeTelemetryTriggerDecision(JSON.stringify({ schema: TELEMETRY_TRIGGER_CONTRACT, decision: "unheard-of", source: "cli" })), undefined);
	assert.equal(decodeTelemetryTriggerDecision(JSON.stringify({ schema: TELEMETRY_TRIGGER_CONTRACT, decision: "enrolled" })), undefined);
	assert.equal(decodeTelemetryTriggerDecision("[]"), undefined);
	assert.equal(decodeTelemetryTriggerDecision("null"), undefined);
});

// ---------------------------------------------------------------------------
// Extension wiring: the once-per-process activation nudge.
// ---------------------------------------------------------------------------

function buildExtensionHarness(overrides: Parameters<typeof createGentleAiExtension>[0] = {}) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, command);
		},
		registerTool() {},
		events: { emit() {} },
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, ...overrides })(pi);
	return { handlers, commands };
}

function fakeContext(cwd: string, notifications: Array<{ message: string; severity: string }>): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		ui: {
			notify(message: string, severity: string) {
				notifications.push({ message, severity });
			},
		},
	} as unknown as ExtensionContext;
}

test("activation: spawns the telemetry trigger exactly once for a primary session", async (t) => {
	t.after(() => __testing.resetTelemetryTriggerGuardForTesting());
	__testing.resetTelemetryTriggerGuardForTesting();
	const fake = fakeSpawn();
	const { handlers } = buildExtensionHarness({
		resolveTelemetryTriggerBinary: () => "/opt/gentle-ai/gentle-ai",
		telemetryTriggerSpawn: fake.spawn,
		// Pin the environment: the ambient shell or CI may carry a kill switch
		// (CI=true, DO_NOT_TRACK=1, GENTLE_AI_TELEMETRY=0) that would suppress the spawn.
		processEnv: { PATH: "/bin" },
	});
	const beforeAgentStart = handlers.get("before_agent_start");
	assert.equal(typeof beforeAgentStart, "function");
	const notifications: Array<{ message: string; severity: string }> = [];
	const ctx = fakeContext("/work/project", notifications);

	// A primary-session event carries no agent name at all.
	await beforeAgentStart!({ systemPrompt: "" }, ctx);
	await beforeAgentStart!({ systemPrompt: "" }, ctx);

	assert.equal(fake.calls.length, 1, "the trigger must be attempted at most once per process");
	const [call] = fake.calls;
	assert.deepEqual(call.args, ["telemetry", "trigger", "--json"]);
	assert.equal(call.options.cwd, "/work/project");
	assert.equal(call.options.detached, true);
	assert.equal(call.options.windowsHide, true);
	assert.equal(call.options.stdio, "ignore");
});

test("activation: never spawns for a named or SDD agent event", async (t) => {
	t.after(() => __testing.resetTelemetryTriggerGuardForTesting());
	__testing.resetTelemetryTriggerGuardForTesting();
	const fake = fakeSpawn();
	const { handlers } = buildExtensionHarness({
		resolveTelemetryTriggerBinary: () => "/opt/gentle-ai/gentle-ai",
		telemetryTriggerSpawn: fake.spawn,
	});
	const beforeAgentStart = handlers.get("before_agent_start");
	const notifications: Array<{ message: string; severity: string }> = [];
	const ctx = fakeContext("/work/project", notifications);

	await beforeAgentStart!({ agentName: "review-risk", systemPrompt: "" }, ctx);
	await beforeAgentStart!({ systemPrompt: "SDD apply executor" }, ctx);

	assert.equal(fake.calls.length, 0, "named/SDD agents must never trigger the nudge");
});

test("activation: a missing binary or spawn error never affects activation", async (t) => {
	t.after(() => __testing.resetTelemetryTriggerGuardForTesting());
	__testing.resetTelemetryTriggerGuardForTesting();
	const { handlers } = buildExtensionHarness({
		resolveTelemetryTriggerBinary: () => {
			throw new Error("package-local-binary-missing: not installed");
		},
	});
	const beforeAgentStart = handlers.get("before_agent_start");
	const notifications: Array<{ message: string; severity: string }> = [];
	const ctx = fakeContext("/work/project", notifications);

	// Must resolve cleanly and produce the ordinary orchestrator prompt fields,
	// never throw or notify about the missing binary.
	const outcome = await beforeAgentStart!({ systemPrompt: "base" }, ctx);
	assert.equal(typeof outcome, "object");
	assert.equal(notifications.length, 0);
});

// ---------------------------------------------------------------------------
// Extension wiring: the foreground /gentle:telemetry slash command.
// ---------------------------------------------------------------------------

function fakeAdapter(result: ExecFileResult): { adapter: ExecFileAdapter; requests: Array<{ file: string; arguments: readonly string[] }> } {
	const requests: Array<{ file: string; arguments: readonly string[] }> = [];
	const adapter: ExecFileAdapter = async (request) => {
		requests.push({ file: request.file, arguments: request.arguments });
		return result;
	};
	return { adapter, requests };
}

test("/gentle:telemetry relays a status --json payload", async () => {
	const payload = { schema: "gentle-ai.telemetry-status/v1", enabled: true, source: "default" };
	const { adapter, requests } = fakeAdapter({
		stdout: `${JSON.stringify(payload)}\n`,
		stderr: "",
		exitCode: 0,
		signal: null,
		timedOut: false,
		outputLimitExceeded: false,
	});
	const { commands } = buildExtensionHarness({
		resolveTelemetryTriggerBinary: () => "/opt/gentle-ai/gentle-ai",
		telemetryExecFileAdapter: adapter,
	});
	const command = commands.get("gentle:telemetry");
	assert.ok(command, "gentle:telemetry must be registered");
	const notifications: Array<{ message: string; severity: string }> = [];
	await command!.handler("", fakeContext("/work/project", notifications));

	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0].arguments, ["telemetry", "status", "--json"]);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].severity, "info");
	assert.deepEqual(JSON.parse(notifications[0].message), payload);
});

test("/gentle:telemetry disable prints a one-line confirmation", async () => {
	const { adapter } = fakeAdapter({
		stdout: `${JSON.stringify({ schema: "gentle-ai.telemetry-status/v1", enabled: false, source: "user" })}\n`,
		stderr: "",
		exitCode: 0,
		signal: null,
		timedOut: false,
		outputLimitExceeded: false,
	});
	const { commands } = buildExtensionHarness({
		resolveTelemetryTriggerBinary: () => "/opt/gentle-ai/gentle-ai",
		telemetryExecFileAdapter: adapter,
	});
	const command = commands.get("gentle:telemetry");
	const notifications: Array<{ message: string; severity: string }> = [];
	await command!.handler("disable", fakeContext("/work/project", notifications));

	assert.deepEqual(notifications, [{ message: "Gentle AI telemetry disabled.", severity: "info" }]);
});

test("/gentle:telemetry relays a typed non-zero failure", async () => {
	const { adapter } = fakeAdapter({
		stdout: "",
		stderr: "unknown telemetry command\n",
		exitCode: 1,
		signal: null,
		timedOut: false,
		outputLimitExceeded: false,
	});
	const { commands } = buildExtensionHarness({
		resolveTelemetryTriggerBinary: () => "/opt/gentle-ai/gentle-ai",
		telemetryExecFileAdapter: adapter,
	});
	const command = commands.get("gentle:telemetry");
	const notifications: Array<{ message: string; severity: string }> = [];
	await command!.handler("preview", fakeContext("/work/project", notifications));

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].severity, "error");
	assert.match(notifications[0].message, /unknown telemetry command/);
});

test("/gentle:telemetry rejects an unknown sub-action without calling the binary", async () => {
	const { adapter, requests } = fakeAdapter({ stdout: "{}", stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false });
	const { commands } = buildExtensionHarness({
		resolveTelemetryTriggerBinary: () => "/opt/gentle-ai/gentle-ai",
		telemetryExecFileAdapter: adapter,
	});
	const command = commands.get("gentle:telemetry");
	const notifications: Array<{ message: string; severity: string }> = [];
	await command!.handler("frobnicate", fakeContext("/work/project", notifications));

	assert.equal(requests.length, 0);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].severity, "warning");
});
