import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { __testing, createDrakoncAiExtension } from "../extensions/drakonc-ai.ts";
import type { ExecFileAdapter, ExecFileResult } from "../lib/native-review-cli.ts";
import { setBundledInstallForTesting } from "../lib/drakonc-shell-bundled.ts";
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
// drakonc-pi#677: drakonc-ai owns telemetry end to end (drakonc-ai#4309); Pi only
// nudges the local binary once per process. These tests cover the pure
// predicate/spawn/decode core in lib/telemetry-trigger.ts and the two ways
// extensions/drakonc-ai.ts wires it in: the once-per-process activation nudge
// and the foreground /drakonc:telemetry slash command relay.
// ---------------------------------------------------------------------------

let fixtureRoot: string | undefined;
let fixtureCwd: string;
const fixtureEnvironment: NodeJS.ProcessEnv = {};
const previousEnvironment = new Map<string, string | undefined>();
before(() => {
	fixtureRoot = mkdtempSync(join(tmpdir(), "drakonc-pi-telemetry-fixture-"));
	fixtureCwd = join(fixtureRoot, "project");
	const home = join(fixtureRoot, "home");
	mkdirSync(fixtureCwd);
	mkdirSync(home);
	Object.assign(fixtureEnvironment, {
		HOME: home, USERPROFILE: home,
		DRAKONC_PI_CONFIG_HOME: join(home, "config"),
		DRAKONC_PI_AGENT_HOME: join(home, "agents"),
		PI_CODING_AGENT_DIR: join(home, "pi"),
		XDG_CONFIG_HOME: join(home, "xdg"),
	});
	for (const [key, value] of Object.entries(fixtureEnvironment)) {
		previousEnvironment.set(key, process.env[key]);
		process.env[key] = value;
	}
});
after(() => {
	for (const [key, value] of previousEnvironment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (fixtureRoot !== undefined) rmSync(fixtureRoot, { recursive: true, force: true });
});

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
		[{ DRAKONC_AI_TELEMETRY: "0" }, false],
		[{ DRAKONC_AI_TELEMETRY: "1" }, true],
		[{ CI: "true" }, false],
		[{ CI: "false" }, true],
		[{ CI: undefined }, true],
		[{ DO_NOT_TRACK: "1", DRAKONC_AI_TELEMETRY: "0", CI: "true" }, false],
	];
	for (const [env, expected] of cases) {
		assert.equal(shouldTriggerTelemetry(env), expected, JSON.stringify(env));
	}
});

test("spawnTelemetryTrigger: launches the expected argv, detached, hidden, and stdio-ignored", () => {
	const fake = fakeSpawn();
	const result = spawnTelemetryTrigger({
		executable: "/opt/drakonc-ai/drakonc-ai",
		cwd: "/work/project",
		env: {},
		spawn: fake.spawn,
	});
	assert.deepEqual(result, { spawned: true, reason: "spawned" });
	assert.equal(fake.calls.length, 1);
	const [call] = fake.calls;
	assert.equal(call.command, "/opt/drakonc-ai/drakonc-ai");
	assert.deepEqual(call.args, ["telemetry", "trigger", "--json"]);
	assert.equal(call.options.cwd, "/work/project");
	assert.equal(call.options.detached, true);
	assert.equal(call.options.windowsHide, true);
	assert.equal(call.options.stdio, "ignore");
});

test("spawnTelemetryTrigger: never spawns under each kill switch", () => {
	const switches: Array<[Record<string, string | undefined>, string]> = [
		[{ DO_NOT_TRACK: "1" }, "do-not-track"],
		[{ DRAKONC_AI_TELEMETRY: "0" }, "telemetry-disabled"],
		[{ CI: "true" }, "ci"],
	];
	for (const [env, reason] of switches) {
		const fake = fakeSpawn();
		const result = spawnTelemetryTrigger({ executable: "drakonc-ai", cwd: "/work", env, spawn: fake.spawn });
		assert.deepEqual(result, { spawned: false, reason }, JSON.stringify(env));
		assert.equal(fake.calls.length, 0, JSON.stringify(env));
	}
});

test("spawnTelemetryTrigger: a throwing spawn is swallowed, never thrown", () => {
	const throwingSpawn: TelemetryTriggerSpawn = () => {
		throw new Error("spawn EAGAIN");
	};
	const result = spawnTelemetryTrigger({ executable: "drakonc-ai", cwd: "/work", env: {}, spawn: throwingSpawn });
	assert.deepEqual(result, { spawned: false, reason: "spawn-error" });
});

test("spawnTelemetryTrigger: the 3 s kill timer fires exactly once and is unref'd", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const fake = fakeSpawn();
	const result = spawnTelemetryTrigger({ executable: "drakonc-ai", cwd: "/work", env: {}, spawn: fake.spawn });
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

function buildExtensionHarness(overrides: Parameters<typeof createDrakoncAiExtension>[0] = {}) {
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
	createDrakoncAiExtension({
		nativeReviewCli: null,
		resolveTelemetryTriggerBinary: () => assert.fail("Telemetry fixtures must inject a binary resolver"),
		telemetryTriggerSpawn: () => assert.fail("Telemetry fixtures must inject a spawn mock"),
		telemetryExecFileAdapter: async () => assert.fail("Telemetry fixtures must inject an exec adapter"),
		...overrides,
		processEnv: { ...fixtureEnvironment, DRAKONC_PI_AGENTS_CHILD: "0", ...overrides.processEnv },
	})(pi);
	return { handlers, commands };
}

function fakeContext(notifications: Array<{ message: string; severity: string }>): ExtensionContext {
	return {
		cwd: fixtureCwd,
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
		resolveTelemetryTriggerBinary: () => "/opt/drakonc-ai/drakonc-ai",
		telemetryTriggerSpawn: fake.spawn,
		// Pin the environment: the ambient shell or CI may carry a kill switch
		// (CI=true, DO_NOT_TRACK=1, DRAKONC_AI_TELEMETRY=0) that would suppress the spawn.
		processEnv: { PATH: "/bin" },
	});
	const beforeAgentStart = handlers.get("before_agent_start");
	assert.equal(typeof beforeAgentStart, "function");
	const notifications: Array<{ message: string; severity: string }> = [];
	const ctx = fakeContext(notifications);

	// A primary-session event carries no agent name at all.
	await beforeAgentStart!({ systemPrompt: "" }, ctx);
	await beforeAgentStart!({ systemPrompt: "" }, ctx);

	assert.equal(fake.calls.length, 1, "the trigger must be attempted at most once per process");
	const [call] = fake.calls;
	assert.equal(call.options.env.DRAKONC_PI_AGENTS_CHILD, "0");
	assert.equal(call.options.env.HOME, fixtureEnvironment.HOME);
	assert.equal(call.options.env.DRAKONC_PI_AGENTS_PARENT_PERMISSION_FD, undefined);
	assert.deepEqual(call.args, ["telemetry", "trigger", "--json"]);
	assert.equal(call.options.cwd, fixtureCwd);
	assert.equal(call.options.detached, true);
	assert.equal(call.options.windowsHide, true);
	assert.equal(call.options.stdio, "ignore");
});

test("activation: never spawns for named agents, even with legacy prompt text", async (t) => {
	t.after(() => __testing.resetTelemetryTriggerGuardForTesting());
	__testing.resetTelemetryTriggerGuardForTesting();
	const fake = fakeSpawn();
	const { handlers } = buildExtensionHarness({
		resolveTelemetryTriggerBinary: () => "/opt/drakonc-ai/drakonc-ai",
		telemetryTriggerSpawn: fake.spawn,
	});
	const beforeAgentStart = handlers.get("before_agent_start");
	const notifications: Array<{ message: string; severity: string }> = [];
	const ctx = fakeContext(notifications);

	await beforeAgentStart!({ agentName: "review-risk", systemPrompt: "" }, ctx);
	await beforeAgentStart!({ agentName: "drakonc-ai-worker", systemPrompt: "SDD apply executor" }, ctx);

	assert.equal(fake.calls.length, 0, "named agents must never trigger the nudge");
});

test("activation: a child session neither spawns telemetry nor appends the primary harness", async (t) => {
	t.after(() => __testing.resetTelemetryTriggerGuardForTesting());
	__testing.resetTelemetryTriggerGuardForTesting();
	const fake = fakeSpawn();
	const { handlers } = buildExtensionHarness({
		resolveTelemetryTriggerBinary: () => "/opt/drakonc-ai/drakonc-ai",
		telemetryTriggerSpawn: fake.spawn,
		processEnv: { DRAKONC_PI_AGENTS_CHILD: "1" },
	});
	const event = { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "Child instructions" } };
	assert.equal(await handlers.get("before_agent_start")!(event, fakeContext([])), undefined);
	assert.equal(fake.calls.length, 0);
	assert.equal(event.systemPromptOptions.appendSystemPrompt, "Child instructions");
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
	const ctx = fakeContext(notifications);

	// Must resolve cleanly and produce the ordinary orchestrator prompt fields
	// in appendSystemPrompt (never a returned systemPrompt), and never throw
	// or notify about the missing binary.
	const event = { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } };
	const outcome = await beforeAgentStart!(event, ctx);
	assert.equal(outcome, undefined, "the handler must not return a replacement systemPrompt");
	assert.match(event.systemPromptOptions.appendSystemPrompt, /el Drakoncman/);
	assert.equal(notifications.length, 0);
});

// ---------------------------------------------------------------------------
// Extension wiring: the foreground /drakonc:telemetry slash command.
// ---------------------------------------------------------------------------

function fakeAdapter(result: ExecFileResult): { adapter: ExecFileAdapter; requests: Array<{ file: string; arguments: readonly string[] }> } {
	const requests: Array<{ file: string; arguments: readonly string[] }> = [];
	const adapter: ExecFileAdapter = async (request) => {
		requests.push({ file: request.file, arguments: request.arguments });
		return result;
	};
	return { adapter, requests };
}

test("/drakonc:telemetry relays a status --json payload", async () => {
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
		resolveTelemetryTriggerBinary: () => "/opt/drakonc-ai/drakonc-ai",
		telemetryExecFileAdapter: adapter,
	});
	const command = commands.get("drakonc:telemetry");
	assert.ok(command, "drakonc:telemetry must be registered");
	const notifications: Array<{ message: string; severity: string }> = [];
	await command!.handler("", fakeContext(notifications));

	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0].arguments, ["telemetry", "status", "--json"]);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].severity, "info");
	assert.deepEqual(JSON.parse(notifications[0].message), payload);
});

test("/drakonc:telemetry disable prints a one-line confirmation", async () => {
	const { adapter } = fakeAdapter({
		stdout: `${JSON.stringify({ schema: "gentle-ai.telemetry-status/v1", enabled: false, source: "user" })}\n`,
		stderr: "",
		exitCode: 0,
		signal: null,
		timedOut: false,
		outputLimitExceeded: false,
	});
	const { commands } = buildExtensionHarness({
		resolveTelemetryTriggerBinary: () => "/opt/drakonc-ai/drakonc-ai",
		telemetryExecFileAdapter: adapter,
	});
	const command = commands.get("drakonc:telemetry");
	const notifications: Array<{ message: string; severity: string }> = [];
	await command!.handler("disable", fakeContext(notifications));

	assert.deepEqual(notifications, [{ message: "Drakonc AI telemetry disabled.", severity: "info" }]);
});

test("/drakonc:telemetry relays a typed non-zero failure", async () => {
	const { adapter } = fakeAdapter({
		stdout: "",
		stderr: "unknown telemetry command\n",
		exitCode: 1,
		signal: null,
		timedOut: false,
		outputLimitExceeded: false,
	});
	const { commands } = buildExtensionHarness({
		resolveTelemetryTriggerBinary: () => "/opt/drakonc-ai/drakonc-ai",
		telemetryExecFileAdapter: adapter,
	});
	const command = commands.get("drakonc:telemetry");
	const notifications: Array<{ message: string; severity: string }> = [];
	await command!.handler("preview", fakeContext(notifications));

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].severity, "error");
	assert.match(notifications[0].message, /unknown telemetry command/);
});

test("/drakonc:telemetry rejects an unknown sub-action without calling the binary", async () => {
	const { adapter, requests } = fakeAdapter({ stdout: "{}", stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false });
	const { commands } = buildExtensionHarness({
		resolveTelemetryTriggerBinary: () => "/opt/drakonc-ai/drakonc-ai",
		telemetryExecFileAdapter: adapter,
	});
	const command = commands.get("drakonc:telemetry");
	const notifications: Array<{ message: string; severity: string }> = [];
	await command!.handler("frobnicate", fakeContext(notifications));

	assert.equal(requests.length, 0);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].severity, "warning");
});

// S9: this package running from a bundled install (the testing overlay stands
// in for its location; the detection itself is tested with real installs in
// drakonc-ai-binary-isolation.test.ts) and the launcher's DRAKONC_SHELL_PREFIX.
// The companion's own home is computed from the OS home, so a temporary HOME
// keeps the expectation exact without touching the real one.
function useTemporaryOsHome(t: { after: (fn: () => void) => void }): string {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "drakonc-ai-isolation-home-")));
	const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	t.after(() => {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(home, { recursive: true, force: true });
	});
	return home;
}

function bundledIsolation(t: { after: (fn: () => void) => void }): { prefix: string; env: NodeJS.ProcessEnv } {
	const prefix = realpathSync(mkdtempSync(join(tmpdir(), "drakonc-ai-isolation-site-")));
	setBundledInstallForTesting({ root: prefix });
	t.after(() => {
		setBundledInstallForTesting(undefined);
		rmSync(prefix, { recursive: true, force: true });
	});
	return { prefix, env: { PATH: "/usr/bin", DRAKONC_SHELL_PREFIX: prefix } };
}

test("spawnTelemetryTrigger: drakonc-ai gets Drakonc AI's isolation variables, inside a bundled install or not", (t) => {
	const osHome = useTemporaryOsHome(t);
	const { prefix, env } = bundledIsolation(t);
	const bundled = fakeSpawn();
	spawnTelemetryTrigger({ executable: "/opt/drakonc-ai/drakonc-ai", cwd: "/work", env, spawn: bundled.spawn });
	assert.equal(bundled.calls[0].options.env?.DRAKONC_AI_HOME, join(prefix, "drakonc-ai"));
	assert.equal(bundled.calls[0].options.env?.GENTLE_AI_HOME, join(prefix, "drakonc-ai"));
	assert.equal(bundled.calls[0].options.env?.DRAKONC_AI_NO_SELF_UPDATE, "1");
	assert.equal(bundled.calls[0].options.env?.GENTLE_AI_NO_SELF_UPDATE, "1");
	const ordinary = fakeSpawn();
	const plain = { PATH: "/usr/bin" };
	spawnTelemetryTrigger({ executable: "/opt/drakonc-ai/drakonc-ai", cwd: "/work", env: plain, spawn: ordinary.spawn });
	const standaloneHome = join(osHome, ".drakonc-shell", "drakonc-ai-home");
	const standalone = ordinary.calls[0].options.env ?? {};
	assert.equal(standalone.DRAKONC_AI_HOME, standaloneHome, "Drakonc's own home, never ~/.gentle-ai");
	assert.equal(standalone.GENTLE_AI_HOME, standaloneHome, "the name the pinned gentle-ai reads");
	assert.equal(standalone.DRAKONC_AI_NO_SELF_UPDATE, "1", "the pinned binary never self-updates");
	assert.equal(standalone.GENTLE_AI_NO_SELF_UPDATE, "1");
	// Outside a prefix and without the launcher marker there is no config folder
	// of its own: the user's home keeps its own.
	assert.equal("DRAKONC_AI_PI_CONFIG_DIR" in standalone, false);
	assert.equal("GENTLE_AI_PI_CONFIG_DIR" in standalone, false);
	assert.equal("GENTLE_PI_CONFIG_HOME" in standalone, false);
	assert.equal(standalone.PATH, "/usr/bin", "the caller's own environment is kept");
});
