import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension, __testing } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import type { ReviewStatusV3 } from "../lib/review-integration-v2.ts";
import { worktreeGitEnvironment } from "../lib/session-worktree-registry.ts";

// S2/S4 (odd/tasks/startup-home-repo-and-changes.md): a repository rooted at
// HOME makes every Git call scan the user's whole tree. Startup warns once and
// skips its review negotiation there; a normal project keeps negotiating, and
// its startup RDD status read serves the first prompt without a respawn.

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type Notice = { message: string; severity: string };
const ENV_KEYS = ["HOME", "USERPROFILE", "GENTLE_PI_CONFIG_HOME", "GENTLE_PI_AGENT_HOME", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME"] as const;

function fixture(t: test.TestContext, gitAtHome: boolean) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-startup-home-")));
	const home = join(root, "home");
	const state = join(root, "state");
	const cwd = join(home, "project");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(state);
	const git = (directory: string) => execFileSync("git", ["init", "--quiet", directory], { env: worktreeGitEnvironment(), stdio: "pipe" });
	git(gitAtHome ? home : cwd);
	const environment: Record<(typeof ENV_KEYS)[number], string> = {
		HOME: home, USERPROFILE: home,
		GENTLE_PI_CONFIG_HOME: join(state, "config"),
		GENTLE_PI_AGENT_HOME: join(state, "agents"),
		PI_CODING_AGENT_DIR: join(state, "pi"),
		XDG_CONFIG_HOME: join(state, "xdg"),
	};
	const previous = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
	Object.assign(process.env, environment);
	__testing.clearRddStatusMemoForTesting();
	t.after(() => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__testing.clearRddStatusMemoForTesting();
		rmSync(root, { recursive: true, force: true });
	});
	return { cwd, environment };
}

function nativeCli() {
	const calls = { mode: 0, target: 0 };
	const cli = {
		reviewMode: async () => {
			calls.mode++;
			return { operation: "status", scope: "clone", status: { global: "", cloneLocal: "on", effective: "on", source: "clone_local" } };
		},
		targetStatus: async () => {
			calls.target++;
			return { applicability: "unrelated", action: "start", targetIdentity: `sha256:${"5".repeat(64)}`, nextTransition: { kind: "stop" } } as unknown as ReviewStatusV3;
		},
	} as unknown as NativeReviewCli;
	return { cli, calls };
}

function start(cli: NativeReviewCli, cwd: string, environment: NodeJS.ProcessEnv) {
	const handlers = new Map<string, AnyHandler>();
	const notices: Notice[] = [];
	const pi = {
		appendEntry() {},
		on(name: string, handler: AnyHandler) { handlers.set(name, handler); },
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: cli,
		processEnv: { ...environment, GENTLE_PI_AGENTS_CHILD: "0", GENTLE_AI_TELEMETRY: "0" },
		resolveTelemetryTriggerBinary: () => join(cwd, "never-executed"),
		telemetryTriggerSpawn: () => assert.fail("Startup fixtures must not spawn telemetry"),
	})(pi);
	const ctx = {
		cwd,
		hasUI: true,
		ui: { notify: (message: string, severity: string) => { notices.push({ message, severity }); } },
		sessionManager: { getSessionId: () => "startup-home-session", getCwd: () => cwd, getEntries: () => [], getBranch: () => [] },
	} as unknown as ExtensionContext;
	return { handlers, notices, ctx };
}

const homeWarning = (notices: Notice[]) => notices.filter(({ message }) => message.includes("rooted at your home folder"));

test("a repository rooted at HOME warns once and skips the startup review negotiation", async (t) => {
	const { cwd, environment } = fixture(t, true);
	const { cli, calls } = nativeCli();
	const { handlers, notices, ctx } = start(cli, cwd, environment);
	await handlers.get("session_start")!({}, ctx);
	const warnings = homeWarning(notices);
	assert.equal(warnings.length, 1, JSON.stringify(notices));
	assert.equal(warnings[0]!.severity, "warning");
	assert.match(warnings[0]!.message, /Open Gentle Shell inside a project folder/);
	assert.equal(calls.target, 0, "no startup review negotiation");
	assert.equal(calls.mode, 0, "no startup review mode spawn");
	await handlers.get("session_start")!({ reason: "reload" }, ctx);
	assert.equal(homeWarning(notices).length, 1, "the warning is shown once per process and repository");
});

test("a normal project repository keeps negotiating and its startup status serves the first prompt", async (t) => {
	const { cwd, environment } = fixture(t, false);
	const { cli, calls } = nativeCli();
	const { handlers, notices, ctx } = start(cli, cwd, environment);
	await handlers.get("session_start")!({}, ctx);
	await __testing.startupNegotiationSettled();
	assert.deepEqual(homeWarning(notices), []);
	assert.equal(calls.target, 1, "startup still negotiates the review target");
	assert.equal(calls.mode, 1);
	const event = { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } };
	await handlers.get("before_agent_start")!(event, ctx);
	assert.equal(calls.mode, 1, "the first prompt reuses the startup review mode status");
	assert.match(event.systemPromptOptions.appendSystemPrompt, /Receipt-driven development: on/);
});

// S7 CR3: an unresolvable HOME is unknown, not a home-rooted repository. The
// bootstrap guard still fails closed there; the startup warning does not.
test("an unresolvable HOME neither warns nor skips the startup review negotiation", async (t) => {
	const { cwd, environment } = fixture(t, false);
	const missingHome = join(cwd, "..", "..", "missing-home");
	process.env.HOME = missingHome;
	process.env.USERPROFILE = missingHome;
	const { cli, calls } = nativeCli();
	const { handlers, notices, ctx } = start(cli, cwd, { ...environment, HOME: missingHome, USERPROFILE: missingHome });
	await handlers.get("session_start")!({}, ctx);
	await __testing.startupNegotiationSettled();
	assert.deepEqual(homeWarning(notices), []);
	assert.equal(calls.target, 1, "startup still negotiates the review target");
});

// S5: Pi awaits session_start handlers one after another, so the native review
// negotiation (two gentle-ai spawns) no longer holds startup. It runs after
// session_start returns, bounded by a signal, and the first prompt still reuses
// its RDD status instead of spawning the same read again.
test("startup returns before the native review negotiation finishes, and the first prompt still reuses its status", async (t) => {
	const { cwd, environment } = fixture(t, false);
	const { cli, calls } = nativeCli();
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const signals: Array<AbortSignal | undefined> = [];
	const slowMode = cli.reviewMode!.bind(cli);
	(cli as { reviewMode: NativeReviewCli["reviewMode"] }).reviewMode = (async (request: { signal?: AbortSignal }) => {
		signals.push(request.signal);
		await gate;
		return slowMode(request as never);
	}) as NativeReviewCli["reviewMode"];
	const { handlers, ctx } = start(cli, cwd, environment);
	const started = handlers.get("session_start")!({}, ctx) as Promise<void>;
	const outcome = await Promise.race([started.then(() => "returned"), new Promise(resolve => setTimeout(() => resolve("blocked"), 500))]);
	assert.equal(outcome, "returned", "session_start must not wait for native review negotiation");
	assert.equal(calls.target, 0, "negotiation is still pending");
	assert.ok(signals[0] instanceof AbortSignal, "the startup review mode read is bounded by a signal");
	const event = { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } };
	const prompt = handlers.get("before_agent_start")!(event, ctx) as Promise<void>;
	release();
	await prompt;
	assert.equal(calls.mode, 1, "the first prompt waits for the in-flight startup read instead of spawning another");
	assert.match(event.systemPromptOptions.appendSystemPrompt, /Receipt-driven development: on/);
	await __testing.startupNegotiationSettled();
	assert.equal(calls.target, 1, "the negotiation still completes after startup");
});
