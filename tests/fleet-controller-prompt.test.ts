import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { FLEET_ROLE_ENV } from "../lib/fleet-role.ts";

// odd/tasks/fleet-orchestrator.md T1: the fleet controller gets the lean fleet
// prompt instead of the ODD orchestrator prompt; members and ordinary sessions
// keep the ODD orchestrator prompt.

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<undefined>;
type MutableEvent = { systemPrompt: string; systemPromptOptions: { appendSystemPrompt: string } };

const REPO_ROOT = join(import.meta.dirname, "..");
const FLEET_PROMPT = readFileSync(join(REPO_ROOT, "assets", "fleet-orchestrator.md"), "utf8").trim();
const ODD_MARKER = /Organic Driven Development \(ODD\) is the predefined workflow of this orchestrator/;

// Scratch stays outside the worktree; it is reported, not removed.
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "gentle-fleet-prompt-")));
const fixtureCwd = join(fixtureRoot, "project");
const home = join(fixtureRoot, "home");
const fixtureEnvironment: NodeJS.ProcessEnv = {
	HOME: home, USERPROFILE: home,
	GENTLE_PI_CONFIG_HOME: join(home, "config"),
	GENTLE_PI_AGENT_HOME: join(home, "agents"),
	PI_CODING_AGENT_DIR: join(home, "pi"),
	XDG_CONFIG_HOME: join(home, "xdg"),
};
const previousEnvironment = new Map<string, string | undefined>();
before(() => {
	mkdirSync(fixtureCwd, { recursive: true });
	mkdirSync(home, { recursive: true });
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
});

async function appendedPrompt(role: string | undefined): Promise<string> {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: null,
		processEnv: { ...fixtureEnvironment, GENTLE_PI_AGENTS_CHILD: "0", GENTLE_AI_TELEMETRY: "0", ...(role ? { [FLEET_ROLE_ENV]: role } : {}) },
		resolveTelemetryTriggerBinary: () => join(fixtureCwd, "never-executed"),
		telemetryTriggerSpawn: () => assert.fail("prompt fixtures must not spawn telemetry"),
	})(pi);
	const event: MutableEvent = { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } };
	const ctx = { cwd: fixtureCwd, hasUI: true, ui: { notify() {} }, sessionManager: { getSessionId: () => `fleet-prompt-${role ?? "none"}` } } as unknown as ExtensionContext;
	await handlers.get("before_agent_start")!(event, ctx);
	return event.systemPromptOptions.appendSystemPrompt;
}

test("the fleet prompt asset stays lean and states the fleet rules", () => {
	assert.ok(Buffer.byteLength(FLEET_PROMPT, "utf8") < 2048, `fleet prompt is ${Buffer.byteLength(FLEET_PROMPT, "utf8")} bytes`);
	for (const rule of [/never edit code/i, /124k/, /steer/i, /digest/i, /human/i, /fleet_spawn/, /merge/i, /language/i]) assert.match(FLEET_PROMPT, rule);
});

test("the fleet controller gets the fleet prompt instead of the ODD orchestrator prompt", async () => {
	const appended = await appendedPrompt("controller");
	assert.ok(appended.includes(FLEET_PROMPT), "the fleet prompt is injected");
	assert.doesNotMatch(appended, ODD_MARKER);
});

test("a fleet member keeps the ODD orchestrator prompt and never sees the fleet prompt", async () => {
	const appended = await appendedPrompt("member");
	assert.match(appended, ODD_MARKER);
	assert.equal(appended.includes(FLEET_PROMPT), false);
});

test("an ordinary session keeps the ODD orchestrator prompt", async () => {
	const appended = await appendedPrompt(undefined);
	assert.match(appended, ODD_MARKER);
	assert.equal(appended.includes(FLEET_PROMPT), false);
});
